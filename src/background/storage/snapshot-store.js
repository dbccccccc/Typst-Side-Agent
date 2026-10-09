/**
 * File-scoped whole-document snapshots: automatic response snapshots, manual
 * entries, and rescue copies written before a restore.
 */
import { LIMITS, STORAGE_KEYS } from '../../shared/constants.js';
import {
  DOCUMENT_SNAPSHOT_KINDS, defaultSnapshotTitle, publicDocumentSnapshot
} from '../../shared/document-snapshot.js';
import { sha256Text } from '../../shared/edit-checkpoint.js';
import { codedError } from '../../shared/errors.js';
import {
  enqueueMutation, isRecordId, jsonBytes, listStorageKeys, readKey, removeKey, validSha256, writeKey
} from './storage-core.js';

const DOCUMENT_SNAPSHOT_SCHEMA_VERSION = 1;

function emptyDocumentSnapshotIndex() {
  return { version: DOCUMENT_SNAPSHOT_SCHEMA_VERSION, entries: [] };
}

function documentSnapshotBodyKey(id) {
  return `${STORAGE_KEYS.DOCUMENT_SNAPSHOT_BODY_PREFIX}${id}`;
}

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validDocumentSnapshotMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if (!isRecordId(meta.id)) return false;
  if (!Object.values(DOCUMENT_SNAPSHOT_KINDS).includes(meta.kind)) return false;
  if (!boundedString(meta.projectId, 256) || !boundedString(meta.fileLabel, 240) || !boundedString(meta.title, 120)) return false;
  if (!validSha256(meta.textHash)) return false;
  if (!Number.isInteger(meta.textLength) || meta.textLength < 0 || meta.textLength > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) return false;
  if (!Number.isFinite(meta.createdAt) || meta.createdAt < 0) return false;
  if (!Number.isFinite(meta.approxBytes) || meta.approxBytes < 0) return false;
  if (typeof meta.bodyKey !== 'string' || !meta.bodyKey.startsWith(STORAGE_KEYS.DOCUMENT_SNAPSHOT_BODY_PREFIX)) return false;
  if (meta.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC) {
    return boundedString(meta.sessionId, 256) && boundedString(meta.runId, 256);
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
    throw codedError(
      'DOCUMENT_SNAPSHOT_INDEX_INVALID',
      'Stored document-snapshot metadata is corrupt or from an unsupported version. Existing snapshot bodies were preserved.'
    );
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

/** Caller must already hold the mutation queue. */
export async function removeDocumentSnapshotsUnlocked(predicate) {
  const index = await loadDocumentSnapshotIndexUnlocked();
  const removed = index.entries.filter(predicate);
  if (!removed.length) return 0;
  const entries = index.entries.filter(entry => !predicate(entry));
  await writeDocumentSnapshotIndexUnlocked({ ...index, entries });
  await Promise.all(removed.map(entry => removeKey(entry.bodyKey).catch(() => {})));
  return removed.length;
}

function validateDocumentSnapshotInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot input must be an object.');
  }
  if (!boundedString(input.projectId, 256)) throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot project identity is invalid.');
  if (!boundedString(input.fileLabel, 240)) throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot file identity is invalid.');
  if (typeof input.text !== 'string' || input.text.length > LIMITS.MAX_EDITOR_TRANSACTION_CHARS) {
    throw codedError('DOCUMENT_SNAPSHOT_TOO_LARGE', 'The document is too large to save as a snapshot.');
  }
  if (!Object.values(DOCUMENT_SNAPSHOT_KINDS).includes(input.kind)) {
    throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Document snapshot kind is invalid.');
  }
  if (input.protectedSnapshotId != null && (input.kind !== DOCUMENT_SNAPSHOT_KINDS.RESCUE || !isRecordId(input.protectedSnapshotId))) {
    throw codedError('INVALID_DOCUMENT_SNAPSHOT', 'Only rescue snapshots may protect the selected recovery point during retention pruning.');
  }
  if (input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && ![input.sessionId, input.runId].every(value => boundedString(value, 256))) {
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
      throw codedError(
        'DOCUMENT_SNAPSHOT_BUDGET_FULL',
        'Manual snapshots currently use the entire local document-recovery budget. Delete one before another automatic snapshot can be saved.'
      );
    }
    kept = kept.filter(entry => entry.id !== victim.id);
    removed.push(victim);
  }
  if (totalBytes() + incomingBytes > LIMITS.MAX_DOCUMENT_SNAPSHOT_TOTAL_BYTES) {
    throw codedError('DOCUMENT_SNAPSHOT_TOO_LARGE', 'This document exceeds the bounded local snapshot budget.');
  }
  return { kept, removed };
}

function titleFor(input) {
  return String(input.title || defaultSnapshotTitle(input.kind)).slice(0, 120);
}

export async function createDocumentSnapshot(input) {
  validateDocumentSnapshotInput(input);
  return enqueueMutation(async () => {
    let index = await loadDocumentSnapshotIndexUnlocked();
    await cleanupOrphanDocumentSnapshotBodiesUnlocked(index);
    const textHash = await sha256Text(input.text);
    const sameText = entry => entry.fileLabel === input.fileLabel && entry.textHash === textHash && entry.textLength === input.text.length;
    const exact = index.entries.find(entry => entry.projectId === input.projectId && sameText(entry));

    if (input.kind !== DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && exact) {
      const keepExisting = exact.kind === DOCUMENT_SNAPSHOT_KINDS.MANUAL ||
        (input.kind === DOCUMENT_SNAPSHOT_KINDS.RESCUE && exact.kind === DOCUMENT_SNAPSHOT_KINDS.RESCUE);
      if (keepExisting) return { snapshot: publicDocumentSnapshot(exact), deduplicated: true, promoted: false };
      const promoted = { ...exact, kind: input.kind, title: titleFor(input), sessionId: null, runId: null, createdAt: Date.now() };
      const entries = index.entries.map(entry => entry.id === exact.id ? promoted : entry);
      await writeDocumentSnapshotIndexUnlocked({ ...index, entries });
      return { snapshot: publicDocumentSnapshot(promoted), deduplicated: true, promoted: true };
    }

    const replaced = input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC
      ? index.entries.filter(entry => (
        entry.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && entry.projectId === input.projectId && entry.sessionId === input.sessionId
      ))
      : [];
    if (input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC) {
      const sameAutomatic = replaced.find(sameText);
      if (sameAutomatic) {
        const refreshed = { ...sameAutomatic, runId: input.runId, title: titleFor(input), createdAt: Date.now() };
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
    if (approxBytes > LIMITS.MAX_DOCUMENT_SNAPSHOT_TOTAL_BYTES) {
      throw codedError('DOCUMENT_SNAPSHOT_TOO_LARGE', 'The document is too large to save within the local snapshot budget.');
    }
    const plan = documentSnapshotPrunePlan(index.entries, approxBytes, input.kind, input.protectedSnapshotId);
    const automatic = input.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC;
    const meta = {
      id,
      kind: input.kind,
      projectId: input.projectId,
      fileLabel: input.fileLabel,
      title: titleFor(input),
      textHash,
      textLength: input.text.length,
      createdAt: Date.now(),
      approxBytes,
      bodyKey,
      sessionId: automatic ? input.sessionId : null,
      runId: automatic ? input.runId : null
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
