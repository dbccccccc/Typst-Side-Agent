/**
 * Versioned chat-session repository (schema v2): a small metadata index plus
 * independently addressed immutable bodies, a resumable legacy migration, and
 * bounded import/export.
 */
import { LIMITS, STORAGE_KEYS } from '../../shared/constants.js';
import { DOCUMENT_SNAPSHOT_KINDS } from '../../shared/document-snapshot.js';
import { codedError } from '../../shared/errors.js';
import { minimizeMessagesForStorage, normalizeImportedSessionRecord } from '../session-normalization.js';
import { removeEditCheckpointsUnlocked } from './checkpoint-store.js';
import { removeDocumentSnapshotsUnlocked } from './snapshot-store.js';
import {
  enqueueMutation, finiteTime, formatBytes, jsonBytes, listStorageKeys, onStorageAdapterReset,
  readKey, removeKey, stableId, storage, writeKey
} from './storage-core.js';

const SESSION_SCHEMA_VERSION = 2;
const EXPORT_FORMAT = 'typst-side-agent-sessions';

let migrationPromise = null;
onStorageAdapterReset(() => { migrationPromise = null; });

// ---------- Keys and metadata ----------

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
    throw codedError(
      'SESSION_INDEX_INVALID',
      'Stored chat metadata is corrupt or from an unsupported version. Existing chat bodies were preserved; export or recover the index before continuing.'
    );
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
    throw codedError(
      'SESSION_TOO_LARGE',
      `Session body is ${formatBytes(bytes)}; the 1 MiB limit was reached. User text remains in memory but was not saved.`
    );
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

function newestFirst(a, b) {
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

async function cleanupBodyBestEffort(key) {
  try { await removeKey(key); }
  catch (error) { console.warn('Typst Side Agent left a session-body orphan for startup cleanup:', error?.message || String(error)); }
}

// ---------- Legacy migration ----------

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
  const writeProgress = () => writeKey(STORAGE_KEYS.SESSION_MIGRATION, { version: 2, complete: false, completedIds: [...completed], rejected });

  for (let i = 0; i < (Array.isArray(legacy) ? legacy.length : 0); i++) {
    const normalized = normalizedLegacy[i];
    if (!normalized.ok) {
      const rejectionId = `legacy-index-${i}`;
      if (!completed.has(rejectionId)) rejected += 1;
      completed.add(rejectionId);
      await writeProgress();
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
    await writeProgress();
  }

  const finalIndex = await loadIndex();
  for (const id of expectedIds) {
    const meta = finalIndex.sessions.find(session => session.id === id);
    if (!meta || !await readBody(meta)) {
      throw codedError('MIGRATION_VERIFY_FAILED', `Migrated session ${id} did not pass final verification.`);
    }
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

// ---------- Public repository operations ----------

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
  if (![1, 2].includes(version) || !Array.isArray(records)) {
    throw codedError('UNSUPPORTED_IMPORT_VERSION', 'Only version-1 and version-2 session exports are supported.');
  }
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
          throw codedError(
            'SESSION_IMPORT_SIZE_LIMIT',
            `Session import exceeds the ${formatBytes(LIMITS.MAX_SESSION_IMPORT_BODY_BYTES)} aggregate body limit.`
          );
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
