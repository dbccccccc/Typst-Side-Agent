import {
  LIMITS, STORAGE_KEYS, normalizeEditorApprovalMode, normalizeSendMessageShortcut
} from '../shared/constants.js';
import {
  customToolTrustFingerprint, hasCurrentCustomToolTrust, hasCurrentMcpServerTrust,
  mcpServerTrustFingerprint
} from '../shared/trust-policy.js';
import { normalizeInsecureAcknowledgement, validateEndpointUrl, validateHeaderRecord } from '../shared/endpoint-policy.js';
import { validateCustomToolRecords } from './tool-registry.js';
import { minimizeMessagesForStorage, normalizeImportedSessionRecord } from './session-normalization.js';
import {
  DEFAULT_EDIT_FILE_LABEL, EDIT_CHECKPOINT_STATUSES, publicEditCheckpoint, sha256Text
} from '../shared/edit-checkpoint.js';
import {
  DOCUMENT_SNAPSHOT_KINDS, defaultSnapshotTitle, publicDocumentSnapshot
} from '../shared/document-snapshot.js';

const SESSION_SCHEMA_VERSION = 2;
const EDIT_CHECKPOINT_SCHEMA_VERSION = 1;
const DOCUMENT_SNAPSHOT_SCHEMA_VERSION = 1;
const EXPORT_FORMAT = 'typst-side-agent-sessions';

let adapterOverride = null;
let mutationQueue = Promise.resolve();
let migrationPromise = null;

function storage() {
  if (adapterOverride) return adapterOverride;
  return chrome.storage.local;
}

export function configureStorageAdapter(adapter) {
  adapterOverride = adapter;
  mutationQueue = Promise.resolve();
  migrationPromise = null;
}

export function resetStorageAdapter() {
  configureStorageAdapter(null);
}

async function readKey(key, fallback) {
  const result = await storage().get(key);
  return result?.[key] ?? fallback;
}

async function writeKey(key, value) {
  try {
    await storage().set({ [key]: value });
  } catch (error) {
    throw storageError(error);
  }
}

async function removeKey(key) {
  try { await storage().remove(key); }
  catch (error) { throw storageError(error); }
}

async function listStorageKeys() {
  return typeof storage().getKeys === 'function'
    ? storage().getKeys()
    : Object.keys(await storage().get(null) || {});
}

function enqueueMutation(operation) {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.catch(() => {});
  return next;
}

// ---------- Settings ----------

const DEFAULT_SETTINGS = Object.freeze({
  systemPrompt: '',
  models: [],
  activeModelId: null,
  maxHistoryMessages: 40,
  autoNameModelId: null,
  editorApprovalMode: 'ask',
  sendMessageShortcut: 'enter'
});

export async function loadSettings() {
  const raw = await readKey(STORAGE_KEYS.SETTINGS, null);
  const settings = raw && typeof raw === 'object' ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
  if (!Array.isArray(settings.models)) settings.models = [];
  settings.models = settings.models.map(model => normalizeInsecureAcknowledgement(model, 'apiBaseUrl'));
  if (!settings.activeModelId && settings.models.length) settings.activeModelId = settings.models[0].id;
  if (!Number.isFinite(settings.maxHistoryMessages)) settings.maxHistoryMessages = DEFAULT_SETTINGS.maxHistoryMessages;
  settings.editorApprovalMode = normalizeEditorApprovalMode(settings.editorApprovalMode);
  settings.sendMessageShortcut = normalizeSendMessageShortcut(settings.sendMessageShortcut);
  return settings;
}

const SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));

function applyModelMutation(settings, mutation) {
  if (!mutation) return settings;
  const models = Array.isArray(settings.models) ? settings.models.map(model => ({ ...model })) : [];
  if (mutation.type === 'upsert') {
    const record = { ...mutation.record };
    const position = models.findIndex(model => model.id === record.id);
    if (position >= 0) models[position] = { ...models[position], ...record };
    else models.push(record);
  } else if (mutation.type === 'remove') {
    const position = models.findIndex(model => model.id === mutation.id);
    if (position >= 0) models.splice(position, 1);
  } else if (mutation.type === 'replace') {
    models.splice(0, models.length, ...mutation.records.map(model => ({ ...model })));
  } else if (mutation.type === 'select') {
    if (!models.some(model => model.id === mutation.id)) throw codedError('UNKNOWN_MODEL', 'Unknown model.');
    return { ...settings, models, activeModelId: mutation.id };
  } else {
    throw codedError('INVALID_MODEL_MUTATION', 'Unsupported model mutation.');
  }
  return {
    ...settings,
    models,
    activeModelId: models.some(model => model.id === settings.activeModelId) ? settings.activeModelId : models[0]?.id || null,
    autoNameModelId: models.some(model => model.id === settings.autoNameModelId) ? settings.autoNameModelId : null
  };
}

function validateSettingsCandidate(settings) {
  const safe = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  safe.editorApprovalMode = normalizeEditorApprovalMode(safe.editorApprovalMode);
  safe.sendMessageShortcut = normalizeSendMessageShortcut(safe.sendMessageShortcut);
  if (!Array.isArray(safe.models)) throw codedError('INVALID_SETTINGS', 'models must be an array');
  safe.models = safe.models.map(model => normalizeInsecureAcknowledgement(model, 'apiBaseUrl'));
  const ids = new Set();
  for (const model of safe.models) {
    if (!model || typeof model !== 'object' || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(model.id || ''))) throw codedError('INVALID_MODEL_ID', 'Every model requires a valid id.');
    if (ids.has(model.id)) throw codedError('DUPLICATE_MODEL_ID', 'Model ids must be unique.');
    ids.add(model.id);
    const endpoint = validateEndpointUrl(model.apiBaseUrl, { insecureConfirmedOrigin: model.insecureTransportAcknowledgedOrigin });
    if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
  }
  if (!ids.has(safe.activeModelId)) safe.activeModelId = safe.models[0]?.id || null;
  if (!ids.has(safe.autoNameModelId)) safe.autoNameModelId = null;
  return safe;
}

export async function saveSettings(settings, options = {}) {
  return enqueueMutation(async () => {
    let candidate;
    const fields = Array.isArray(options.fields) ? options.fields.filter(field => SETTINGS_FIELDS.has(field)) : null;
    if (fields || options.modelMutation) {
      candidate = await loadSettings();
      for (const field of fields || []) {
        if (Object.prototype.hasOwnProperty.call(settings || {}, field)) candidate[field] = settings[field];
      }
      candidate = applyModelMutation(candidate, options.modelMutation);
    } else {
      candidate = settings;
    }
    const safe = validateSettingsCandidate(candidate);
    await writeKey(STORAGE_KEYS.SETTINGS, safe);
    return { ok: true, settings: safe };
  });
}

// ---------- Versioned session repository ----------

function legacyBodyKey(id) {
  return STORAGE_KEYS.SESSION_BODY_PREFIX + id;
}

function createVersionedBodyKey(id) {
  return `${STORAGE_KEYS.SESSION_BODY_PREFIX}${id}.${crypto.randomUUID()}`;
}

function bodyKeyFor(meta) {
  return meta?.bodyKey || legacyBodyKey(meta?.id);
}

function emptyIndex() {
  return { version: SESSION_SCHEMA_VERSION, sessions: [] };
}

function validIndexMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if (typeof meta.id !== 'string' || !meta.id) return false;
  if (meta.bodyKey != null && (typeof meta.bodyKey !== 'string' || !meta.bodyKey.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX))) return false;
  return typeof meta.projectId === 'string'
    && typeof meta.name === 'string'
    && Number.isFinite(meta.createdAt)
    && Number.isFinite(meta.updatedAt)
    && Number.isInteger(meta.messageCount)
    && meta.messageCount >= 0
    && Number.isFinite(meta.approxBytes)
    && meta.approxBytes >= 0;
}

async function readIndexState() {
  const index = await readKey(STORAGE_KEYS.SESSION_INDEX, null);
  if (index == null) return { status: 'missing', index: emptyIndex() };
  if (index.version !== SESSION_SCHEMA_VERSION || !Array.isArray(index.sessions) || !index.sessions.every(validIndexMetadata)) {
    throw codedError('SESSION_INDEX_INVALID', 'Stored chat metadata is corrupt or from an unsupported version. Existing chat bodies were preserved; export or recover the index before continuing.');
  }
  return { status: 'valid', index };
}

async function loadIndex() {
  return (await readIndexState()).index;
}

async function writeIndex(index) {
  await writeKey(STORAGE_KEYS.SESSION_INDEX, index);
}

async function readBody(meta) {
  const id = meta?.id;
  const body = await readKey(bodyKeyFor(meta), null);
  if (!body || body.version !== SESSION_SCHEMA_VERSION || body.id !== id || !Array.isArray(body.messages)) return null;
  return body;
}

function createBody(id, messages) {
  const minimized = minimizeMessagesForStorage(messages || []);
  if (!minimized.ok) throw codedError(minimized.error.code, minimized.error.message);
  const body = { version: SESSION_SCHEMA_VERSION, id, messages: minimized.value };
  const bytes = jsonBytes(body);
  if (bytes > LIMITS.MAX_SESSION_BODY_BYTES) {
    throw codedError('SESSION_TOO_LARGE', `Session body is ${formatBytes(bytes)}; the 1 MiB limit was reached. User text remains in memory but was not saved.`);
  }
  return { body, bytes };
}

function createLegacyBody(id, messages) {
  try { return createBody(id, messages); }
  catch (error) {
    if (error.code !== 'SESSION_TOO_LARGE') throw error;
    // Migration must preserve valid historical user text. Oversized legacy
    // bodies are retained and labelled; new writes still enforce the cap.
    const body = { version: SESSION_SCHEMA_VERSION, id, messages, oversizedLegacy: true };
    return { body, bytes: jsonBytes(body) };
  }
}

function legacySessionId(value, index) {
  return value.id || `legacy-${index}-${stableId(`${value.projectId}\u0000${value.name}`)}`;
}

function collisionSafeLegacyId(baseId, value, index, attempt = 0) {
  const fingerprint = stableId(JSON.stringify({
    projectId: value.projectId,
    name: value.name,
    messages: value.messages
  }));
  return `${String(baseId).slice(0, 80)}-legacy-${index}-${fingerprint}${attempt ? `-${attempt}` : ''}`;
}

async function legacyRecordMatches(meta, value) {
  const body = await readBody(meta);
  return !!body && meta.projectId === String(value.projectId || '') && meta.name === String(value.name || 'New chat').slice(0, 200) &&
    JSON.stringify(body.messages) === JSON.stringify(value.messages);
}

async function resolveLegacyMigrationId(baseId, value, index, duplicateBaseIds, currentIndex) {
  let candidate = duplicateBaseIds.has(baseId) ? collisionSafeLegacyId(baseId, value, index) : baseId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const existing = currentIndex.sessions.find(meta => meta.id === candidate);
    if (!existing || await legacyRecordMatches(existing, value)) return candidate;
    candidate = collisionSafeLegacyId(baseId, value, index, attempt + 1);
  }
  throw codedError('MIGRATION_ID_COLLISION', 'Could not allocate a unique id for a legacy session. Existing data was preserved.');
}

function metadataFor(session, bytes, bodyKey) {
  const summary = sessionSummary(session.messages);
  return {
    id: session.id,
    projectId: String(session.projectId || ''),
    name: String(session.name || 'New chat').slice(0, 200),
    createdAt: finiteTime(session.createdAt),
    updatedAt: finiteTime(session.updatedAt),
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    approxBytes: bytes,
    bodyKey,
    preview: summary.preview,
    searchText: summary.searchText,
    userRenamed: !!session.userRenamed
  };
}

function sessionSummary(messages) {
  let preview = '';
  const searchable = [];
  let remaining = 4_000;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content !== 'string') continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!preview && message.role === 'user') preview = text.slice(0, 160);
    if (remaining > 0) {
      const part = text.slice(0, remaining);
      searchable.push(part);
      remaining -= part.length;
    }
    if (preview && remaining <= 0) break;
  }
  return { preview, searchText: searchable.join(' ').toLowerCase() };
}

async function materialize(meta) {
  const body = await readBody(meta);
  if (!body) return null;
  return { ...meta, messages: body.messages };
}

async function ensureRepository() {
  if (!migrationPromise) {
    migrationPromise = enqueueMutation(async () => {
      await assertMissingIndexIsRecoverableUnlocked();
      const marker = await migrateLegacyUnlocked();
      await backfillSessionSummariesUnlocked();
      await cleanupOrphanBodiesUnlocked();
      return marker;
    });
  }
  const attempt = migrationPromise;
  try {
    return await attempt;
  } catch (error) {
    if (migrationPromise === attempt) migrationPromise = null;
    throw error;
  }
}

async function assertMissingIndexIsRecoverableUnlocked() {
  const { status } = await readIndexState();
  if (status === 'valid') return;
  const keys = await listStorageKeys();
  const bodyKeys = keys.filter(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX));
  if (bodyKeys.length === 0) return;

  const marker = await readKey(STORAGE_KEYS.SESSION_MIGRATION, null);
  const legacy = await readKey(STORAGE_KEYS.SESSIONS, null);
  if (!marker?.complete && Array.isArray(legacy) && legacy.length > 0) {
    const expectedBodies = new Map();
    let unambiguous = true;
    legacy.forEach((record, index) => {
      const normalized = normalizeImportedSessionRecord(record);
      if (!normalized.ok) return;
      const id = legacySessionId(normalized.value, index);
      const serialized = JSON.stringify(createLegacyBody(id, normalized.value.messages).body);
      if (expectedBodies.has(id) && expectedBodies.get(id) !== serialized) unambiguous = false;
      expectedBodies.set(id, serialized);
    });
    for (const key of bodyKeys) {
      const body = await readKey(key, null);
      if (!body || expectedBodies.get(body.id) !== JSON.stringify(body)) unambiguous = false;
    }
    if (unambiguous) return;
  }
  throw codedError(
    'SESSION_INDEX_MISSING',
    'Stored chat metadata is missing while chat bodies still exist. Existing bodies were preserved; recover or remove them before creating new chats.'
  );
}

async function backfillSessionSummariesUnlocked() {
  const { status, index } = await readIndexState();
  if (status !== 'valid') return;
  let changed = false;
  const sessions = [];
  for (const meta of index.sessions) {
    if (typeof meta.preview === 'string' && typeof meta.searchText === 'string') {
      sessions.push(meta);
      continue;
    }
    const body = await readBody(meta);
    if (!body) {
      sessions.push(meta);
      continue;
    }
    sessions.push({ ...meta, ...sessionSummary(body.messages) });
    changed = true;
  }
  if (changed) await writeIndex({ ...index, sessions });
}

async function migrateLegacyUnlocked() {
  const marker = await readKey(STORAGE_KEYS.SESSION_MIGRATION, null);
  if (marker?.complete) {
    await removeKey(STORAGE_KEYS.SESSIONS);
    return marker;
  }
  const legacy = await readKey(STORAGE_KEYS.SESSIONS, []);
  let index = await loadIndex();
  const completed = new Set(Array.isArray(marker?.completedIds) ? marker.completedIds : []);
  const expectedIds = new Set();
  let rejected = Number(marker?.rejected || 0);
  const normalizedLegacy = (Array.isArray(legacy) ? legacy : []).map(raw => normalizeImportedSessionRecord(raw));
  const baseIdCounts = new Map();
  normalizedLegacy.forEach((normalized, legacyIndex) => {
    if (!normalized.ok) return;
    const baseId = legacySessionId(normalized.value, legacyIndex);
    baseIdCounts.set(baseId, (baseIdCounts.get(baseId) || 0) + 1);
  });
  const duplicateBaseIds = new Set([...baseIdCounts].filter(([, count]) => count > 1).map(([id]) => id));

  for (let i = 0; i < (Array.isArray(legacy) ? legacy.length : 0); i++) {
    const normalized = normalizedLegacy[i];
    if (!normalized.ok) {
      const rejectionId = `legacy-index-${i}`;
      if (!completed.has(rejectionId)) rejected += 1;
      completed.add(rejectionId);
      await writeKey(STORAGE_KEYS.SESSION_MIGRATION, { version: 2, complete: false, completedIds: [...completed], rejected });
      continue;
    }
    const value = normalized.value;
    const id = await resolveLegacyMigrationId(legacySessionId(value, i), value, i, duplicateBaseIds, index);
    expectedIds.add(id);
    if (completed.has(id) && index.sessions.some(meta => meta.id === id)) continue;
    const existing = index.sessions.find(meta => meta.id === id);
    if (!existing) {
      const built = createLegacyBody(id, value.messages);
      const storageKey = createVersionedBodyKey(id);
      await writeKey(storageKey, built.body);
      const verified = await readBody({ id, bodyKey: storageKey });
      if (!verified) throw codedError('MIGRATION_VERIFY_FAILED', 'Could not verify a migrated session body.');
      const session = { ...value, id };
      index = { ...index, sessions: [...index.sessions, metadataFor(session, built.bytes, storageKey)] };
      await writeIndex(index);
    }
    completed.add(id);
    await writeKey(STORAGE_KEYS.SESSION_MIGRATION, { version: 2, complete: false, completedIds: [...completed], rejected });
  }

  const finalIndex = await loadIndex();
  for (const id of expectedIds) {
    const meta = finalIndex.sessions.find(session => session.id === id);
    if (!meta || !await readBody(meta)) throw codedError('MIGRATION_VERIFY_FAILED', `Migrated session ${id} did not pass final verification.`);
  }
  const finalMarker = { version: 2, complete: true, completedIds: [...completed], rejected, completedAt: Date.now() };
  await writeKey(STORAGE_KEYS.SESSION_MIGRATION, finalMarker);
  if (Array.isArray(legacy)) await removeKey(STORAGE_KEYS.SESSIONS);
  return finalMarker;
}

async function cleanupOrphanBodiesUnlocked() {
  const { status, index } = await readIndexState();
  // A missing index may be a fresh install, but it can also be the only lost
  // half of a previously committed repository. Never infer that bodies are
  // disposable unless a valid index was actually loaded.
  if (status !== 'valid') return;
  const referenced = new Set(index.sessions.map(bodyKeyFor));
  const keys = await listStorageKeys();
  const orphans = keys.filter(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX) && !referenced.has(key));
  if (orphans.length) await removeKey(orphans);
}

async function cleanupBodyBestEffort(key) {
  try { await removeKey(key); }
  catch (error) { console.warn('Typst Side Agent left a session-body orphan for startup cleanup:', error?.message || String(error)); }
}

export async function loadSessions() {
  await ensureRepository();
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const sessions = await Promise.all(index.sessions.map(materialize));
    return sessions.filter(Boolean);
  });
}

export async function sessionList(projectId) {
  await ensureRepository();
  const index = await loadIndex();
  return index.sessions
    .filter(session => session.projectId === projectId)
    .map(session => publicSessionMetadata(session))
    .sort(newestFirst);
}

export async function sessionCreate(projectId, name) {
  await ensureRepository();
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      projectId: String(projectId || ''),
      name: String(name || 'New chat').slice(0, 200),
      messages: [],
      createdAt: now,
      updatedAt: now,
      userRenamed: false
    };
    const { body, bytes } = createBody(session.id, []);
    const storageKey = createVersionedBodyKey(session.id);
    await writeKey(storageKey, body);
    try {
      await writeIndex({ ...index, sessions: [...index.sessions, metadataFor(session, bytes, storageKey)] });
    } catch (error) {
      await cleanupBodyBestEffort(storageKey);
      throw error;
    }
    return session;
  });
}

export async function sessionGet(sessionId) {
  await ensureRepository();
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const meta = index.sessions.find(session => session.id === sessionId);
    return meta ? materialize(meta) : null;
  });
}

export async function sessionUpdate(sessionId, updates) {
  await ensureRepository();
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const position = index.sessions.findIndex(session => session.id === sessionId);
    if (position < 0) return null;
    const oldMeta = index.sessions[position];
    const oldBody = await readBody(oldMeta);
    if (!oldBody) throw codedError('SESSION_BODY_MISSING', 'The session body is missing.');
    if (updates.autoName === true && oldMeta.userRenamed) return { ...oldMeta, messages: oldBody.messages };
    const next = {
      ...oldMeta,
      name: 'name' in updates ? String(updates.name || 'New chat').slice(0, 200) : oldMeta.name,
      messages: 'messages' in updates ? updates.messages : oldBody.messages,
      updatedAt: Date.now(),
      userRenamed: 'userRenamed' in updates ? !!updates.userRenamed : oldMeta.userRenamed
    };
    const { body, bytes } = createBody(sessionId, next.messages);
    const storageKey = createVersionedBodyKey(sessionId);
    await writeKey(storageKey, body);
    const nextMeta = metadataFor(next, bytes, storageKey);
    const sessions = index.sessions.slice();
    sessions[position] = nextMeta;
    try {
      await writeIndex({ ...index, sessions });
    } catch (error) {
      await cleanupBodyBestEffort(storageKey);
      throw error;
    }
    if (bodyKeyFor(oldMeta) !== storageKey) await cleanupBodyBestEffort(bodyKeyFor(oldMeta));
    return { ...nextMeta, messages: body.messages };
  });
}

export async function sessionDelete(sessionId) {
  await ensureRepository();
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const removedMeta = index.sessions.find(session => session.id === sessionId);
    const sessions = index.sessions.filter(session => session.id !== sessionId);
    await removeEditCheckpointsUnlocked(entry => entry.sessionId === sessionId);
    await removeDocumentSnapshotsUnlocked(entry => (
      entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && entry.sessionId === sessionId
    ));
    await writeIndex({ ...index, sessions });
    if (removedMeta) await cleanupBodyBestEffort(bodyKeyFor(removedMeta));
    return { ok: true, removed: index.sessions.length - sessions.length };
  });
}

export async function sessionListAllGrouped() {
  await ensureRepository();
  const all = (await loadIndex()).sessions;
  const groups = new Map();
  for (const session of all) {
    if (!groups.has(session.projectId || '')) groups.set(session.projectId || '', []);
    groups.get(session.projectId || '').push(session);
  }
  return [...groups].map(([projectId, sessions]) => {
    sessions.sort(newestFirst);
    return {
      projectId,
      sessions: sessions.map(session => publicSessionMetadata(session, { includeSearchText: true })),
      lastActivity: sessions.reduce((max, session) => Math.max(max, session.updatedAt || 0), 0),
      totalMessages: sessions.reduce((sum, session) => sum + (session.messageCount || 0), 0),
      approxBytes: sessions.reduce((sum, session) => sum + (session.approxBytes || 0), 0)
    };
  }).sort((a, b) => b.lastActivity - a.lastActivity);
}

function publicSessionMetadata(session, options = {}) {
  return {
    id: session.id,
    projectId: session.projectId,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    approxBytes: session.approxBytes,
    preview: session.preview,
    ...(options.includeSearchText ? { searchText: session.searchText } : {}),
    userRenamed: !!session.userRenamed
  };
}

export async function sessionDeleteByProject(projectId) {
  await ensureRepository();
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const removed = index.sessions.filter(session => session.projectId === projectId);
    const kept = index.sessions.filter(session => session.projectId !== projectId);
    await removeEditCheckpointsUnlocked(entry => entry.projectId === projectId);
    await removeDocumentSnapshotsUnlocked(entry => (
      entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && entry.projectId === projectId
    ));
    await writeIndex({ ...index, sessions: kept });
    await Promise.all(removed.map(session => cleanupBodyBestEffort(bodyKeyFor(session))));
    return { ok: true, removed: removed.length };
  });
}

export async function sessionImport(input) {
  await ensureRepository();
  const version = Array.isArray(input) ? 1 : Number(input?.version || 1);
  const records = Array.isArray(input) ? input : input?.sessions;
  if (![1, 2].includes(version) || !Array.isArray(records)) throw codedError('UNSUPPORTED_IMPORT_VERSION', 'Only version-1 and version-2 session exports are supported.');
  if (records.length > LIMITS.MAX_SESSION_IMPORT_RECORDS) {
    throw codedError('SESSION_IMPORT_RECORD_LIMIT', `Session import exceeds the ${LIMITS.MAX_SESSION_IMPORT_RECORDS}-record limit.`);
  }
  return enqueueMutation(async () => {
    const index = await loadIndex();
    const existingIds = new Set(index.sessions.map(session => session.id));
    const prepared = [];
    let rejected = 0;
    let aggregateBytes = 0;
    for (const record of records) {
      const normalized = normalizeImportedSessionRecord(record);
      if (!normalized.ok) { rejected += 1; continue; }
      const value = normalized.value;
      let id = value.id || crypto.randomUUID();
      if (existingIds.has(id)) id = crypto.randomUUID();
      existingIds.add(id);
      const session = { ...value, id };
      try {
        const { body, bytes } = createBody(id, session.messages);
        aggregateBytes += bytes;
        if (aggregateBytes > LIMITS.MAX_SESSION_IMPORT_BODY_BYTES) {
          throw codedError('SESSION_IMPORT_SIZE_LIMIT', `Session import exceeds the ${formatBytes(LIMITS.MAX_SESSION_IMPORT_BODY_BYTES)} aggregate body limit.`);
        }
        const storageKey = createVersionedBodyKey(id);
        prepared.push({ body, storageKey, meta: metadataFor(session, bytes, storageKey) });
      } catch (error) {
        if (error.code === 'SESSION_IMPORT_SIZE_LIMIT') throw error;
        if (error.code === 'SESSION_TOO_LARGE' || error.code === 'INVALID_SESSION_RECORD') {
          rejected += 1;
          continue;
        }
        throw error;
      }
    }
    const written = [];
    try {
      for (const item of prepared) {
        await writeKey(item.storageKey, item.body);
        written.push(item.storageKey);
      }
      await writeIndex({ ...index, sessions: [...index.sessions, ...prepared.map(item => item.meta)] });
    } catch (error) {
      await Promise.all(written.map(cleanupBodyBestEffort));
      throw error;
    }
    return { ok: true, imported: prepared.length, rejected };
  });
}

export async function sessionExport() {
  const sessions = await loadSessions();
  return {
    format: EXPORT_FORMAT,
    version: 2,
    exportedAt: Date.now(),
    retention: {
      previewMaxBytes: 200 * 1024,
      toolResultMaxChars: LIMITS.MAX_PERSISTED_TOOL_RESULT_CHARS,
      sessionMaxBytes: LIMITS.MAX_SESSION_BODY_BYTES
    },
    sessions: sessions.map(session => ({
      id: session.id,
      projectId: session.projectId,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map(message => {
        const { editorStateUpdates: _localEditorStateUpdates, ...portable } = message;
        return portable;
      })
    }))
  };
}

export async function sessionStorageStatus() {
  await ensureRepository();
  let bytes;
  if (typeof storage().getBytesInUse === 'function') bytes = await storage().getBytesInUse(null);
  else bytes = jsonBytes(await storage().get(null));
  return { bytes, warning: bytes >= LIMITS.STORAGE_WARNING_BYTES, warningThreshold: LIMITS.STORAGE_WARNING_BYTES };
}

// ---------- Bounded edit checkpoints ----------

function emptyEditCheckpointIndex() {
  return { version: EDIT_CHECKPOINT_SCHEMA_VERSION, entries: [] };
}

function editCheckpointBodyKey(id) {
  return `${STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX}${id}`;
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validEditCheckpointMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(meta.id || ''))) return false;
  if (!Object.values(EDIT_CHECKPOINT_STATUSES).includes(meta.status)) return false;
  if (typeof meta.previousStatus !== 'string' || !['', EDIT_CHECKPOINT_STATUSES.APPLIED].includes(meta.previousStatus)) return false;
  if (meta.bodyKey != null && (typeof meta.bodyKey !== 'string' || !meta.bodyKey.startsWith(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX))) return false;
  const baseValid = [meta.projectId, meta.sessionId, meta.runId, meta.callId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    && typeof meta.fileLabel === 'string' && meta.fileLabel.length > 0 && meta.fileLabel.length <= 240
    && validSha256(meta.beforeHash)
    && Number.isInteger(meta.beforeLength) && meta.beforeLength >= 0 && meta.beforeLength <= LIMITS.MAX_EDITOR_TRANSACTION_CHARS
    && (meta.afterHash == null || validSha256(meta.afterHash))
    && (meta.afterLength == null || (Number.isInteger(meta.afterLength) && meta.afterLength >= 0 && meta.afterLength <= LIMITS.MAX_EDITOR_TRANSACTION_CHARS))
    && (meta.pendingAfterHash == null || validSha256(meta.pendingAfterHash))
    && (meta.pendingAfterLength == null || (Number.isInteger(meta.pendingAfterLength) && meta.pendingAfterLength >= 0 && meta.pendingAfterLength <= LIMITS.MAX_EDITOR_TRANSACTION_CHARS))
    && (meta.previousAfterHash == null || validSha256(meta.previousAfterHash))
    && (meta.previousAfterLength == null || (Number.isInteger(meta.previousAfterLength) && meta.previousAfterLength >= 0 && meta.previousAfterLength <= LIMITS.MAX_EDITOR_TRANSACTION_CHARS))
    && Number.isFinite(meta.createdAt) && meta.createdAt >= 0
    && Number.isFinite(meta.updatedAt) && meta.updatedAt >= 0
    && Number.isFinite(meta.approxBytes) && meta.approxBytes >= 0;
  if (!baseValid) return false;

  const hasBody = typeof meta.bodyKey === 'string';
  const hasAfter = validSha256(meta.afterHash) && Number.isInteger(meta.afterLength);
  const hasPending = validSha256(meta.pendingAfterHash) && Number.isInteger(meta.pendingAfterLength);
  const hasPrevious = validSha256(meta.previousAfterHash) && Number.isInteger(meta.previousAfterLength);
  if (meta.status === EDIT_CHECKPOINT_STATUSES.PREPARED) {
    if (!hasBody || !hasPending || !hasPrevious) return false;
    return meta.previousStatus === EDIT_CHECKPOINT_STATUSES.APPLIED ? hasAfter : meta.afterHash == null && meta.afterLength == null;
  }
  if ([EDIT_CHECKPOINT_STATUSES.APPLIED, EDIT_CHECKPOINT_STATUSES.REVERTING].includes(meta.status)) {
    return hasBody && hasAfter && !meta.previousStatus
      && meta.pendingAfterHash == null && meta.pendingAfterLength == null
      && meta.previousAfterHash == null && meta.previousAfterLength == null;
  }
  return meta.status === EDIT_CHECKPOINT_STATUSES.REVERTED
    && meta.bodyKey == null && meta.approxBytes === 0 && hasAfter && !meta.previousStatus
    && meta.pendingAfterHash == null && meta.pendingAfterLength == null
    && meta.previousAfterHash == null && meta.previousAfterLength == null;
}

async function loadEditCheckpointIndexUnlocked() {
  const index = await readKey(STORAGE_KEYS.EDIT_CHECKPOINT_INDEX, null);
  if (index == null) return emptyEditCheckpointIndex();
  if (
    index.version !== EDIT_CHECKPOINT_SCHEMA_VERSION ||
    !Array.isArray(index.entries) ||
    index.entries.length > LIMITS.MAX_EDIT_CHECKPOINTS ||
    !index.entries.every(validEditCheckpointMetadata) ||
    index.entries.reduce((sum, entry) => sum + entry.approxBytes, 0) > LIMITS.MAX_EDIT_CHECKPOINT_TOTAL_BYTES
  ) {
    throw codedError('EDIT_CHECKPOINT_INDEX_INVALID', 'Stored edit-checkpoint metadata is corrupt or from an unsupported version. Existing checkpoint bodies were preserved.');
  }
  return index;
}

async function writeEditCheckpointIndexUnlocked(index) {
  await writeKey(STORAGE_KEYS.EDIT_CHECKPOINT_INDEX, index);
}

async function readEditCheckpointBodyUnlocked(meta) {
  if (!meta?.bodyKey) return null;
  const body = await readKey(meta.bodyKey, null);
  if (!body || body.version !== EDIT_CHECKPOINT_SCHEMA_VERSION || body.id !== meta.id || typeof body.beforeText !== 'string') return null;
  return body;
}

async function cleanupOrphanEditCheckpointBodiesUnlocked(index) {
  const referenced = new Set(index.entries.map(entry => entry.bodyKey).filter(Boolean));
  const keys = await listStorageKeys();
  const orphans = keys.filter(key => key.startsWith(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX) && !referenced.has(key));
  if (orphans.length) await removeKey(orphans);
}

async function removeEditCheckpointsUnlocked(predicate) {
  const index = await loadEditCheckpointIndexUnlocked();
  const removed = index.entries.filter(predicate);
  if (!removed.length) return 0;
  const entries = index.entries.filter(entry => !predicate(entry));
  await writeEditCheckpointIndexUnlocked({ ...index, entries });
  await Promise.all(removed.map(entry => entry.bodyKey ? removeKey(entry.bodyKey).catch(() => {}) : null));
  return removed.length;
}

function validateCheckpointStageInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint input must be an object.');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(input.id || ''))) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint id is invalid.');
  if (![input.projectId, input.sessionId, input.runId, input.callId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint identity is incomplete or too long.');
  if (typeof input.beforeText !== 'string' || input.beforeText.length > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) throw codedError('EDIT_CHECKPOINT_TOO_LARGE', 'The document is too large to retain a safe revert checkpoint.');
  if (!validSha256(input.beforeHash) || !validSha256(input.pendingAfterHash)) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint hashes are invalid.');
  if (!Number.isInteger(input.pendingAfterLength) || input.pendingAfterLength < 0 || input.pendingAfterLength > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint length is invalid.');
}

async function pruneEditCheckpointsUnlocked(index, incomingBytes) {
  let entries = index.entries.slice();
  const victims = [];
  const now = Date.now();
  const totalBytes = () => entries.reduce((sum, entry) => sum + entry.approxBytes, 0);
  const ordered = () => entries.slice().sort((a, b) => {
    const aRank = a.status === EDIT_CHECKPOINT_STATUSES.REVERTED ? 0 : 1;
    const bRank = b.status === EDIT_CHECKPOINT_STATUSES.REVERTED ? 0 : 1;
    return aRank - bRank || a.createdAt - b.createdAt;
  });
  while (entries.length >= LIMITS.MAX_EDIT_CHECKPOINTS || totalBytes() + incomingBytes > LIMITS.MAX_EDIT_CHECKPOINT_TOTAL_BYTES) {
    const victim = ordered().find(entry => {
      const inFlight = [EDIT_CHECKPOINT_STATUSES.PREPARED, EDIT_CHECKPOINT_STATUSES.REVERTING].includes(entry.status);
      return !inFlight || now - entry.updatedAt >= LIMITS.EDIT_CHECKPOINT_IN_FLIGHT_TTL_MS;
    });
    if (!victim) throw codedError('EDIT_CHECKPOINT_HISTORY_BUSY', 'All retained revert checkpoints are currently in use. Wait for active edits or reverts to finish and retry.');
    entries = entries.filter(entry => entry.id !== victim.id);
    victims.push(victim);
  }
  if (totalBytes() + incomingBytes > LIMITS.MAX_EDIT_CHECKPOINT_TOTAL_BYTES) {
    throw codedError('EDIT_CHECKPOINT_TOO_LARGE', 'The revert checkpoint exceeds the bounded local edit-history budget.');
  }
  if (victims.length) {
    await writeEditCheckpointIndexUnlocked({ ...index, entries });
    await Promise.all(victims.map(victim => victim.bodyKey ? removeKey(victim.bodyKey).catch(() => {}) : null));
  }
  return { ...index, entries };
}

export async function stageEditCheckpoint(input) {
  validateCheckpointStageInput(input);
  return enqueueMutation(async () => {
    let index = await loadEditCheckpointIndexUnlocked();
    await cleanupOrphanEditCheckpointBodiesUnlocked(index);
    if (index.entries.some(entry => entry.id === input.id)) throw codedError('DUPLICATE_EDIT_CHECKPOINT', 'An edit checkpoint with this id already exists.');
    const bodyKey = editCheckpointBodyKey(input.id);
    const body = { version: EDIT_CHECKPOINT_SCHEMA_VERSION, id: input.id, beforeText: input.beforeText };
    const bytes = jsonBytes(body);
    if (bytes > LIMITS.MAX_EDIT_CHECKPOINT_TOTAL_BYTES) throw codedError('EDIT_CHECKPOINT_TOO_LARGE', 'The document is too large to retain a safe revert checkpoint.');
    index = await pruneEditCheckpointsUnlocked(index, bytes);
    const now = Date.now();
    const meta = {
      id: input.id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      callId: input.callId,
      fileLabel: String(input.fileLabel || DEFAULT_EDIT_FILE_LABEL).slice(0, 240),
      status: EDIT_CHECKPOINT_STATUSES.PREPARED,
      previousStatus: '',
      beforeHash: input.beforeHash,
      beforeLength: input.beforeText.length,
      afterHash: null,
      afterLength: null,
      pendingAfterHash: input.pendingAfterHash,
      pendingAfterLength: input.pendingAfterLength,
      previousAfterHash: input.beforeHash,
      previousAfterLength: input.beforeText.length,
      createdAt: now,
      updatedAt: now,
      approxBytes: bytes,
      bodyKey
    };
    await writeKey(bodyKey, body);
    try {
      await writeEditCheckpointIndexUnlocked({ ...index, entries: [...index.entries, meta] });
    } catch (error) {
      await removeKey(bodyKey).catch(() => {});
      throw error;
    }
    return meta;
  });
}

export async function prepareEditCheckpointUpdate(id, pending) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const position = index.entries.findIndex(entry => entry.id === id);
    if (position < 0) throw codedError('EDIT_CHECKPOINT_NOT_FOUND', 'The edit checkpoint is no longer available.');
    const current = index.entries[position];
    if (current.status !== EDIT_CHECKPOINT_STATUSES.APPLIED || !validSha256(pending?.pendingAfterHash) || !Number.isInteger(pending?.pendingAfterLength) || pending.pendingAfterLength < 0 || pending.pendingAfterLength > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) {
      throw codedError('EDIT_CHECKPOINT_STATE_INVALID', 'The edit checkpoint cannot stage another document change.');
    }
    const next = {
      ...current,
      status: EDIT_CHECKPOINT_STATUSES.PREPARED,
      previousStatus: EDIT_CHECKPOINT_STATUSES.APPLIED,
      previousAfterHash: current.afterHash,
      previousAfterLength: current.afterLength,
      pendingAfterHash: pending.pendingAfterHash,
      pendingAfterLength: pending.pendingAfterLength,
      callId: String(pending.callId || current.callId).slice(0, 128),
      updatedAt: Date.now()
    };
    const entries = index.entries.slice();
    entries[position] = next;
    await writeEditCheckpointIndexUnlocked({ ...index, entries });
    return next;
  });
}

export async function commitEditCheckpoint(id) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const position = index.entries.findIndex(entry => entry.id === id);
    if (position < 0) throw codedError('EDIT_CHECKPOINT_NOT_FOUND', 'The edit checkpoint is no longer available.');
    const current = index.entries[position];
    if (current.status !== EDIT_CHECKPOINT_STATUSES.PREPARED || !current.pendingAfterHash) throw codedError('EDIT_CHECKPOINT_STATE_INVALID', 'The edit checkpoint is not awaiting a commit.');
    const next = {
      ...current,
      status: EDIT_CHECKPOINT_STATUSES.APPLIED,
      previousStatus: '',
      afterHash: current.pendingAfterHash,
      afterLength: current.pendingAfterLength,
      pendingAfterHash: null,
      pendingAfterLength: null,
      previousAfterHash: null,
      previousAfterLength: null,
      updatedAt: Date.now()
    };
    const entries = index.entries.slice();
    entries[position] = next;
    await writeEditCheckpointIndexUnlocked({ ...index, entries });
    return publicEditCheckpoint(next);
  });
}

export async function rollbackEditCheckpointPreparation(id) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const position = index.entries.findIndex(entry => entry.id === id);
    if (position < 0) return { ok: true, removed: false };
    const current = index.entries[position];
    if (current.status !== EDIT_CHECKPOINT_STATUSES.PREPARED) return { ok: true, removed: false };
    if (current.previousStatus === EDIT_CHECKPOINT_STATUSES.APPLIED) {
      const next = {
        ...current,
        status: EDIT_CHECKPOINT_STATUSES.APPLIED,
        previousStatus: '',
        afterHash: current.previousAfterHash,
        afterLength: current.previousAfterLength,
        pendingAfterHash: null,
        pendingAfterLength: null,
        previousAfterHash: null,
        previousAfterLength: null,
        updatedAt: Date.now()
      };
      const entries = index.entries.slice();
      entries[position] = next;
      await writeEditCheckpointIndexUnlocked({ ...index, entries });
      return { ok: true, removed: false, checkpoint: publicEditCheckpoint(next) };
    }
    const entries = index.entries.filter(entry => entry.id !== id);
    await writeEditCheckpointIndexUnlocked({ ...index, entries });
    if (current.bodyKey) await removeKey(current.bodyKey).catch(() => {});
    return { ok: true, removed: true };
  });
}

export async function loadEditCheckpoint(id) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const meta = index.entries.find(entry => entry.id === id);
    if (!meta) return null;
    const body = await readEditCheckpointBodyUnlocked(meta);
    return { ...meta, beforeText: body?.beforeText ?? null };
  });
}

/**
 * Load the selected checkpoint and every later checkpoint from the same chat.
 * Index position is the durable response order; timestamps may legitimately tie.
 */
export async function loadEditCheckpointCascade(id) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const position = index.entries.findIndex(entry => entry.id === id);
    if (position < 0) return null;
    const selected = index.entries[position];
    const scoped = index.entries.slice(position).filter(entry =>
      entry.projectId === selected.projectId && entry.sessionId === selected.sessionId
    );
    const records = [];
    for (const meta of scoped) {
      const body = await readEditCheckpointBodyUnlocked(meta);
      records.push({ ...meta, beforeText: body?.beforeText ?? null });
    }
    return records;
  });
}

async function updateEditCheckpointStatus(id, expectedStatuses, status) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const position = index.entries.findIndex(entry => entry.id === id);
    if (position < 0) throw codedError('EDIT_CHECKPOINT_NOT_FOUND', 'The edit checkpoint is no longer available.');
    const current = index.entries[position];
    if (!expectedStatuses.includes(current.status)) throw codedError('EDIT_CHECKPOINT_STATE_INVALID', `The edit checkpoint is already ${current.status}.`);
    const next = { ...current, status, updatedAt: Date.now() };
    const entries = index.entries.slice();
    entries[position] = next;
    await writeEditCheckpointIndexUnlocked({ ...index, entries });
    return next;
  });
}

export function beginEditCheckpointRevert(id) {
  return updateEditCheckpointStatus(id, [EDIT_CHECKPOINT_STATUSES.APPLIED], EDIT_CHECKPOINT_STATUSES.REVERTING);
}

export function restoreEditCheckpointApplied(id) {
  return updateEditCheckpointStatus(id, [EDIT_CHECKPOINT_STATUSES.REVERTING], EDIT_CHECKPOINT_STATUSES.APPLIED);
}

export async function markEditCheckpointReverted(id) {
  return enqueueMutation(async () => {
    const index = await loadEditCheckpointIndexUnlocked();
    const position = index.entries.findIndex(entry => entry.id === id);
    if (position < 0) throw codedError('EDIT_CHECKPOINT_NOT_FOUND', 'The edit checkpoint is no longer available.');
    const current = index.entries[position];
    if (![EDIT_CHECKPOINT_STATUSES.REVERTING, EDIT_CHECKPOINT_STATUSES.APPLIED].includes(current.status)) throw codedError('EDIT_CHECKPOINT_STATE_INVALID', `The edit checkpoint is already ${current.status}.`);
    const next = {
      ...current,
      status: EDIT_CHECKPOINT_STATUSES.REVERTED,
      bodyKey: null,
      approxBytes: 0,
      updatedAt: Date.now()
    };
    const entries = index.entries.slice();
    entries[position] = next;
    await writeEditCheckpointIndexUnlocked({ ...index, entries });
    if (current.bodyKey) await removeKey(current.bodyKey).catch(() => {});
    return publicEditCheckpoint(next);
  });
}

// ---------- File-scoped document snapshots ----------

function emptyDocumentSnapshotIndex() {
  return { version: DOCUMENT_SNAPSHOT_SCHEMA_VERSION, entries: [] };
}

function documentSnapshotBodyKey(id) {
  return `${STORAGE_KEYS.DOCUMENT_SNAPSHOT_BODY_PREFIX}${id}`;
}

function validDocumentSnapshotMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(meta.id || ''))) return false;
  if (!Object.values(DOCUMENT_SNAPSHOT_KINDS).includes(meta.kind)) return false;
  if (typeof meta.projectId !== 'string' || !meta.projectId || meta.projectId.length > 256) return false;
  if (typeof meta.fileLabel !== 'string' || !meta.fileLabel || meta.fileLabel.length > 240) return false;
  if (typeof meta.title !== 'string' || !meta.title || meta.title.length > 120) return false;
  if (!validSha256(meta.textHash)) return false;
  if (!Number.isInteger(meta.textLength) || meta.textLength < 0 || meta.textLength > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) return false;
  if (!Number.isFinite(meta.createdAt) || meta.createdAt < 0) return false;
  if (!Number.isFinite(meta.approxBytes) || meta.approxBytes < 0) return false;
  if (typeof meta.bodyKey !== 'string' || !meta.bodyKey.startsWith(STORAGE_KEYS.DOCUMENT_SNAPSHOT_BODY_PREFIX)) return false;
  if (meta.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC) {
    return typeof meta.sessionId === 'string' && meta.sessionId.length > 0 && meta.sessionId.length <= 256
      && typeof meta.runId === 'string' && meta.runId.length > 0 && meta.runId.length <= 256;
  }
  return meta.sessionId == null && meta.runId == null;
}

async function loadDocumentSnapshotIndexUnlocked() {
  const index = await readKey(STORAGE_KEYS.DOCUMENT_SNAPSHOT_INDEX, null);
  if (index == null) return emptyDocumentSnapshotIndex();
  if (
    index.version !== DOCUMENT_SNAPSHOT_SCHEMA_VERSION ||
    !Array.isArray(index.entries) ||
    index.entries.length > LIMITS.MAX_DOCUMENT_SNAPSHOTS ||
    !index.entries.every(validDocumentSnapshotMetadata) ||
    index.entries.reduce((sum, entry) => sum + entry.approxBytes, 0) > LIMITS.MAX_DOCUMENT_SNAPSHOT_TOTAL_BYTES
  ) {
    throw codedError('DOCUMENT_SNAPSHOT_INDEX_INVALID', 'Stored document-snapshot metadata is corrupt or from an unsupported version. Existing snapshot bodies were preserved.');
  }
  return index;
}

async function writeDocumentSnapshotIndexUnlocked(index) {
  await writeKey(STORAGE_KEYS.DOCUMENT_SNAPSHOT_INDEX, index);
}

async function readDocumentSnapshotBodyUnlocked(meta) {
  if (!meta?.bodyKey) return null;
  const body = await readKey(meta.bodyKey, null);
  if (!body || body.version !== DOCUMENT_SNAPSHOT_SCHEMA_VERSION || body.id !== meta.id || typeof body.text !== 'string') return null;
  return body;
}

async function cleanupOrphanDocumentSnapshotBodiesUnlocked(index) {
  const referenced = new Set(index.entries.map(entry => entry.bodyKey));
  const keys = await listStorageKeys();
  const orphans = keys.filter(key => key.startsWith(STORAGE_KEYS.DOCUMENT_SNAPSHOT_BODY_PREFIX) && !referenced.has(key));
  if (orphans.length) await removeKey(orphans);
}

async function removeDocumentSnapshotsUnlocked(predicate) {
  const index = await loadDocumentSnapshotIndexUnlocked();
  const removed = index.entries.filter(predicate);
  if (!removed.length) return 0;
  const entries = index.entries.filter(entry => !predicate(entry));
  await writeDocumentSnapshotIndexUnlocked({ ...index, entries });
  await Promise.all(removed.map(entry => removeKey(entry.bodyKey).catch(() => {})));
  return removed.length;
}

function validateDocumentSnapshotInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot input must be an object.');
  if (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 256) throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot project identity is invalid.');
  if (typeof input.fileLabel !== 'string' || !input.fileLabel || input.fileLabel.length > 240) throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot file identity is invalid.');
  if (typeof input.text !== 'string' || input.text.length > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) throw codedError('DOCUMENT_SNAPSHOT_TOO_LARGE', 'The document is too large to save as a snapshot.');
  if (!Object.values(DOCUMENT_SNAPSHOT_KINDS).includes(input.kind)) throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot kind is invalid.');
  if (input.protectedSnapshotId != null && (input.kind !== DOCUMENT_SNAPSHOT_KINDS.RESCUE || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(input.protectedSnapshotId)))) {
    throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Only rescue snapshots may protect the selected recovery point during retention pruning.');
  }
  if (input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && ![input.sessionId, input.runId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) {
    throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Automatic snapshots require chat and run identity.');
  }
}

function documentSnapshotPrunePlan(entries, incomingBytes, incomingKind, protectedSnapshotId = null) {
  let kept = entries.slice();
  const removed = [];
  const totalBytes = () => kept.reduce((sum, entry) => sum + entry.approxBytes, 0);
  const rank = entry => entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC
    ? 0
    : entry.kind === DOCUMENT_SNAPSHOT_KINDS.RESCUE ? 1 : 2;
  while (kept.length >= LIMITS.MAX_DOCUMENT_SNAPSHOTS || totalBytes() + incomingBytes > LIMITS.MAX_DOCUMENT_SNAPSHOT_TOTAL_BYTES) {
    const candidates = kept
      .filter(entry => entry.id !== protectedSnapshotId)
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    const victim = incomingKind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC
      ? candidates.find(entry => entry.kind !== DOCUMENT_SNAPSHOT_KINDS.MANUAL)
      : candidates[0];
    if (!victim) {
      throw codedError('DOCUMENT_SNAPSHOT_BUDGET_FULL', 'Manual snapshots currently use the entire local document-recovery budget. Delete one before another automatic snapshot can be saved.');
    }
    kept = kept.filter(entry => entry.id !== victim.id);
    removed.push(victim);
  }
  if (totalBytes() + incomingBytes > LIMITS.MAX_DOCUMENT_SNAPSHOT_TOTAL_BYTES) {
    throw codedError('DOCUMENT_SNAPSHOT_TOO_LARGE', 'This document exceeds the bounded local snapshot budget.');
  }
  return { kept, removed };
}

export async function createDocumentSnapshot(input) {
  validateDocumentSnapshotInput(input);
  return enqueueMutation(async () => {
    let index = await loadDocumentSnapshotIndexUnlocked();
    await cleanupOrphanDocumentSnapshotBodiesUnlocked(index);
    const textHash = await sha256Text(input.text);
    const exact = index.entries.find(entry => (
      entry.projectId === input.projectId && entry.fileLabel === input.fileLabel &&
      entry.textHash === textHash && entry.textLength === input.text.length
    ));

    if (input.kind !== DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && exact) {
      if (exact.kind === DOCUMENT_SNAPSHOT_KINDS.MANUAL || (
        input.kind === DOCUMENT_SNAPSHOT_KINDS.RESCUE && exact.kind === DOCUMENT_SNAPSHOT_KINDS.RESCUE
      )) {
        return { snapshot: publicDocumentSnapshot(exact), deduplicated: true, promoted: false };
      }
      const promoted = {
        ...exact,
        kind: input.kind,
        title: String(input.title || defaultSnapshotTitle(input.kind)).slice(0, 120),
        sessionId: null,
        runId: null,
        createdAt: Date.now()
      };
      const entries = index.entries.map(entry => entry.id === exact.id ? promoted : entry);
      await writeDocumentSnapshotIndexUnlocked({ ...index, entries });
      return { snapshot: publicDocumentSnapshot(promoted), deduplicated: true, promoted: true };
    }

    const replaced = input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC
      ? index.entries.filter(entry => entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && entry.projectId === input.projectId && entry.sessionId === input.sessionId)
      : [];
    if (input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC) {
      const sameAutomatic = replaced.find(entry => entry.fileLabel === input.fileLabel && entry.textHash === textHash && entry.textLength === input.text.length);
      if (sameAutomatic) {
        const refreshed = {
          ...sameAutomatic,
          runId: input.runId,
          title: String(input.title || defaultSnapshotTitle(input.kind)).slice(0, 120),
          createdAt: Date.now()
        };
        const discarded = replaced.filter(entry => entry.id !== sameAutomatic.id);
        const entries = index.entries
          .filter(entry => !discarded.some(item => item.id === entry.id))
          .map(entry => entry.id === sameAutomatic.id ? refreshed : entry);
        await writeDocumentSnapshotIndexUnlocked({ ...index, entries });
        await Promise.all(discarded.map(entry => removeKey(entry.bodyKey).catch(() => {})));
        return { snapshot: publicDocumentSnapshot(refreshed), deduplicated: true, promoted: false };
      }
      index = { ...index, entries: index.entries.filter(entry => !replaced.some(item => item.id === entry.id)) };
    }

    const id = `snapshot-${crypto.randomUUID()}`;
    const bodyKey = documentSnapshotBodyKey(id);
    const body = { version: DOCUMENT_SNAPSHOT_SCHEMA_VERSION, id, text: input.text };
    const approxBytes = jsonBytes(body);
    if (approxBytes > LIMITS.MAX_DOCUMENT_SNAPSHOT_TOTAL_BYTES) throw codedError('DOCUMENT_SNAPSHOT_TOO_LARGE', 'The document is too large to save within the local snapshot budget.');
    const plan = documentSnapshotPrunePlan(index.entries, approxBytes, input.kind, input.protectedSnapshotId);
    const meta = {
      id,
      kind: input.kind,
      projectId: input.projectId,
      fileLabel: input.fileLabel,
      title: String(input.title || defaultSnapshotTitle(input.kind)).slice(0, 120),
      textHash,
      textLength: input.text.length,
      createdAt: Date.now(),
      approxBytes,
      bodyKey,
      sessionId: input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC ? input.sessionId : null,
      runId: input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC ? input.runId : null
    };
    await writeKey(bodyKey, body);
    try {
      await writeDocumentSnapshotIndexUnlocked({ ...index, entries: [...plan.kept, meta] });
    } catch (error) {
      await removeKey(bodyKey).catch(() => {});
      throw error;
    }
    const obsolete = [...replaced, ...plan.removed];
    await Promise.all(obsolete.map(entry => removeKey(entry.bodyKey).catch(() => {})));
    return { snapshot: publicDocumentSnapshot(meta), deduplicated: false, promoted: false };
  });
}

export async function listDocumentSnapshots({ projectId, fileLabel, sessionId = null }) {
  return enqueueMutation(async () => {
    const index = await loadDocumentSnapshotIndexUnlocked();
    return index.entries
      .filter(entry => entry.projectId === projectId && entry.fileLabel === fileLabel && (
        entry.kind !== DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC || entry.sessionId === sessionId
      ))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicDocumentSnapshot)
      .filter(Boolean);
  });
}

export async function loadDocumentSnapshot(id) {
  return enqueueMutation(async () => {
    const index = await loadDocumentSnapshotIndexUnlocked();
    const meta = index.entries.find(entry => entry.id === id);
    if (!meta) return null;
    const body = await readDocumentSnapshotBodyUnlocked(meta);
    return { ...meta, text: body?.text ?? null };
  });
}

export async function deleteDocumentSnapshot({ id, projectId }) {
  return enqueueMutation(async () => {
    const index = await loadDocumentSnapshotIndexUnlocked();
    const target = index.entries.find(entry => entry.id === id);
    if (!target || target.projectId !== projectId) return { ok: true, removed: 0 };
    const entries = index.entries.filter(entry => entry.id !== id);
    await writeDocumentSnapshotIndexUnlocked({ ...index, entries });
    await removeKey(target.bodyKey).catch(() => {});
    return { ok: true, removed: 1, snapshot: publicDocumentSnapshot(target) };
  });
}

export function deleteAutomaticDocumentSnapshots({ projectId, sessionId, fileLabel = null }) {
  return enqueueMutation(() => removeDocumentSnapshotsUnlocked(entry => (
    entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC &&
    entry.projectId === projectId && entry.sessionId === sessionId &&
    (fileLabel == null || entry.fileLabel === fileLabel)
  )));
}

export function invalidateAutomaticDocumentSnapshots({ projectId, sessionId, fileLabel, textHash, textLength }) {
  if (!validSha256(textHash) || !Number.isInteger(textLength) || textLength < 0) {
    return Promise.reject(codedError('INVALID_DOCUMENT_SNAPSHOT_STATE', 'Live document snapshot state is invalid.'));
  }
  return enqueueMutation(() => removeDocumentSnapshotsUnlocked(entry => (
    entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC &&
    entry.projectId === projectId && entry.sessionId === sessionId && entry.fileLabel === fileLabel &&
    (entry.textHash !== textHash || entry.textLength !== textLength)
  )));
}

// ---------- Tool and MCP settings ----------

export async function loadCustomTools() {
  const tools = await readKey(STORAGE_KEYS.CUSTOM_TOOLS, []);
  return Array.isArray(tools) ? tools.map(normalizeCustomTool) : [];
}

function applyRecordMutation(records, mutation) {
  if (!mutation) return records;
  if (mutation.type === 'replace') return mutation.records.map(record => ({ ...record }));
  if (mutation.type === 'upsert') {
    const next = records.map(record => ({ ...record }));
    const position = next.findIndex(record => record.id === mutation.record.id);
    if (position >= 0) next[position] = { ...next[position], ...mutation.record };
    else next.push({ ...mutation.record });
    return next;
  }
  if (mutation.type === 'remove') return records.filter(record => record.id !== mutation.id);
  if (mutation.type === 'toggle') return records.map(record => record.id === mutation.id ? { ...record, enabled: record.enabled === false } : record);
  throw codedError('INVALID_REGISTRY_MUTATION', 'Unsupported registry mutation.');
}

export async function saveCustomTools(tools, mutation = null) {
  return enqueueMutation(async () => {
    const candidate = mutation ? applyRecordMutation(await loadCustomTools(), mutation) : tools;
    const check = validateCustomToolRecords(candidate);
    if (!check.ok) throw codedError(check.error.code, check.error.message);
    const safe = candidate.map(normalizeCustomTool);
    for (const tool of safe) {
      const endpoint = validateEndpointUrl(tool.endpoint, { insecureConfirmedOrigin: tool.insecureTransportAcknowledgedOrigin });
      if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
      const headers = validateHeaderRecord(tool.headers);
      if (!headers.ok) throw codedError(headers.error.code, headers.error.message);
    }
    await writeKey(STORAGE_KEYS.CUSTOM_TOOLS, safe);
    return { ok: true, records: safe };
  });
}

export async function loadMcpServers() {
  const servers = await readKey(STORAGE_KEYS.MCP_SERVERS, []);
  return Array.isArray(servers) ? servers.map(normalizeMcpServer) : [];
}

export async function saveMcpServers(servers, mutation = null) {
  return enqueueMutation(async () => {
    const candidate = mutation ? applyRecordMutation(await loadMcpServers(), mutation) : servers;
    if (!Array.isArray(candidate)) throw codedError('INVALID_MCP_SETTINGS', 'MCP servers must be an array.');
    const safe = candidate.map(normalizeMcpServer);
    const ids = new Set();
    for (const server of safe) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(server?.id || ''))) throw codedError('INVALID_MCP_SERVER_ID', 'Every MCP server requires a valid id.');
      if (ids.has(server.id)) throw codedError('DUPLICATE_MCP_SERVER_ID', 'MCP server ids must be unique.');
      ids.add(server.id);
      const endpoint = validateEndpointUrl(server.url, { insecureConfirmedOrigin: server.insecureTransportAcknowledgedOrigin });
      if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
      const headers = validateHeaderRecord(server.headers, { mcp: true });
      if (!headers.ok) throw codedError(headers.error.code, headers.error.message);
      if (!['auto', '2026-07-28'].includes(server.protocolMode || 'auto')) throw codedError('UNSUPPORTED_MCP_VERSION', 'Supported MCP modes are Auto and 2026-07-28.');
    }
    await writeKey(STORAGE_KEYS.MCP_SERVERS, safe);
    return { ok: true, records: safe };
  });
}

// ---------- Theme and access level ----------

export async function loadTheme() {
  return readKey(STORAGE_KEYS.THEME, 'dark');
}

export async function saveTheme(theme) {
  await writeKey(STORAGE_KEYS.THEME, theme === 'light' ? 'light' : 'dark');
  return { ok: true };
}

export async function restrictStorageAccess() {
  const local = storage();
  if (typeof local.setAccessLevel !== 'function') return { ok: false, unsupported: true };
  try {
    await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return { ok: true };
  } catch (error) {
    console.warn('Typst Side Agent could not restrict storage access:', error?.message || String(error));
    return { ok: false, error: error?.message || String(error) };
  }
}

function newestFirst(a, b) {
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

function normalizeCustomTool(tool) {
  const endpointSafe = normalizeInsecureAcknowledgement(tool, 'endpoint');
  const trusted = hasCurrentCustomToolTrust(endpointSafe);
  return {
    ...endpointSafe,
    trustedAutoRun: trusted,
    trustedAutoRunFingerprint: trusted ? customToolTrustFingerprint(endpointSafe) : null
  };
}

function normalizeMcpServer(server) {
  const endpointSafe = normalizeInsecureAcknowledgement({ ...server, protocolMode: server?.protocolMode || 'auto' }, 'url');
  const trusted = hasCurrentMcpServerTrust(endpointSafe);
  return {
    ...endpointSafe,
    trustedAutoRun: trusted,
    trustedAutoRunFingerprint: trusted ? mcpServerTrustFingerprint(endpointSafe) : null
  };
}

function finiteTime(value) {
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

function stableId(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function storageError(error) {
  const message = error?.message || String(error);
  if (/quota|QUOTA_BYTES/i.test(message)) return codedError('STORAGE_QUOTA_EXCEEDED', 'Chrome local-storage quota was exceeded. The current in-memory chat is unsaved; export or delete old sessions and retry.');
  return codedError('STORAGE_WRITE_FAILED', `Could not save local data: ${message}`);
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details != null) error.details = details;
  return error;
}
