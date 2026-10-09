/**
 * Bounded pre-edit document checkpoints behind response-level Revert.
 *
 * The write-ahead states are prepared -> applied -> reverting -> reverted.
 * `prepared` records keep both the prior committed hash and the pending hash so
 * an interrupted page commit can be reconciled against the live document.
 */
import { LIMITS, STORAGE_KEYS } from '../../shared/constants.js';
import {
  DEFAULT_EDIT_FILE_LABEL, EDIT_CHECKPOINT_STATUSES, publicEditCheckpoint
} from '../../shared/edit-checkpoint.js';
import { codedError } from '../../shared/errors.js';
import {
  enqueueMutation, isRecordId, jsonBytes, listStorageKeys, readKey, removeKey, validSha256, writeKey
} from './storage-core.js';

const EDIT_CHECKPOINT_SCHEMA_VERSION = 1;
const MAX_TEXT = LIMITS.MAX_EDITOR_TRANSACTION_CHARS;

function emptyEditCheckpointIndex() {
  return { version: EDIT_CHECKPOINT_SCHEMA_VERSION, entries: [] };
}

function editCheckpointBodyKey(id) {
  return `${STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX}${id}`;
}

function boundedLength(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TEXT;
}

function optionalHashPair(hash, length) {
  return (hash == null || validSha256(hash)) && (length == null || boundedLength(length));
}

function validEditCheckpointMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if (!isRecordId(meta.id)) return false;
  if (!Object.values(EDIT_CHECKPOINT_STATUSES).includes(meta.status)) return false;
  if (typeof meta.previousStatus !== 'string' || !['', EDIT_CHECKPOINT_STATUSES.APPLIED].includes(meta.previousStatus)) return false;
  if (meta.bodyKey != null && (typeof meta.bodyKey !== 'string' || !meta.bodyKey.startsWith(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX))) return false;
  const identity = [meta.projectId, meta.sessionId, meta.runId, meta.callId];
  const baseValid = identity.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    && typeof meta.fileLabel === 'string' && meta.fileLabel.length > 0 && meta.fileLabel.length <= 240
    && validSha256(meta.beforeHash) && boundedLength(meta.beforeLength)
    && optionalHashPair(meta.afterHash, meta.afterLength)
    && optionalHashPair(meta.pendingAfterHash, meta.pendingAfterLength)
    && optionalHashPair(meta.previousAfterHash, meta.previousAfterLength)
    && Number.isFinite(meta.createdAt) && meta.createdAt >= 0
    && Number.isFinite(meta.updatedAt) && meta.updatedAt >= 0
    && Number.isFinite(meta.approxBytes) && meta.approxBytes >= 0;
  if (!baseValid) return false;

  const hasBody = typeof meta.bodyKey === 'string';
  const hasAfter = validSha256(meta.afterHash) && Number.isInteger(meta.afterLength);
  const hasPending = validSha256(meta.pendingAfterHash) && Number.isInteger(meta.pendingAfterLength);
  const hasPrevious = validSha256(meta.previousAfterHash) && Number.isInteger(meta.previousAfterLength);
  const noPending = meta.pendingAfterHash == null && meta.pendingAfterLength == null
    && meta.previousAfterHash == null && meta.previousAfterLength == null;
  if (meta.status === EDIT_CHECKPOINT_STATUSES.PREPARED) {
    if (!hasBody || !hasPending || !hasPrevious) return false;
    return meta.previousStatus === EDIT_CHECKPOINT_STATUSES.APPLIED
      ? hasAfter
      : meta.afterHash == null && meta.afterLength == null;
  }
  if ([EDIT_CHECKPOINT_STATUSES.APPLIED, EDIT_CHECKPOINT_STATUSES.REVERTING].includes(meta.status)) {
    return hasBody && hasAfter && !meta.previousStatus && noPending;
  }
  return meta.status === EDIT_CHECKPOINT_STATUSES.REVERTED
    && meta.bodyKey == null && meta.approxBytes === 0 && hasAfter && !meta.previousStatus && noPending;
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
    throw codedError(
      'EDIT_CHECKPOINT_INDEX_INVALID',
      'Stored edit-checkpoint metadata is corrupt or from an unsupported version. Existing checkpoint bodies were preserved.'
    );
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

/** Caller must already hold the mutation queue. */
export async function removeEditCheckpointsUnlocked(predicate) {
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
  if (!isRecordId(input.id)) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint id is invalid.');
  const identity = [input.projectId, input.sessionId, input.runId, input.callId];
  if (!identity.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) {
    throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint identity is incomplete or too long.');
  }
  if (typeof input.beforeText !== 'string' || input.beforeText.length > MAX_TEXT) {
    throw codedError('EDIT_CHECKPOINT_TOO_LARGE', 'The document is too large to retain a safe revert checkpoint.');
  }
  if (!validSha256(input.beforeHash) || !validSha256(input.pendingAfterHash)) {
    throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint hashes are invalid.');
  }
  if (!boundedLength(input.pendingAfterLength)) throw codedError('INVALID_EDIT_CHECKPOINT', 'Edit checkpoint length is invalid.');
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
    if (!victim) {
      throw codedError(
        'EDIT_CHECKPOINT_HISTORY_BUSY',
        'All retained revert checkpoints are currently in use. Wait for active edits or reverts to finish and retry.'
      );
    }
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
    if (index.entries.some(entry => entry.id === input.id)) {
      throw codedError('DUPLICATE_EDIT_CHECKPOINT', 'An edit checkpoint with this id already exists.');
    }
    const bodyKey = editCheckpointBodyKey(input.id);
    const body = { version: EDIT_CHECKPOINT_SCHEMA_VERSION, id: input.id, beforeText: input.beforeText };
    const bytes = jsonBytes(body);
    if (bytes > LIMITS.MAX_EDIT_CHECKPOINT_TOTAL_BYTES) {
      throw codedError('EDIT_CHECKPOINT_TOO_LARGE', 'The document is too large to retain a safe revert checkpoint.');
    }
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
    const validPending = validSha256(pending?.pendingAfterHash) && boundedLength(pending?.pendingAfterLength);
    if (current.status !== EDIT_CHECKPOINT_STATUSES.APPLIED || !validPending) {
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
    if (current.status !== EDIT_CHECKPOINT_STATUSES.PREPARED || !current.pendingAfterHash) {
      throw codedError('EDIT_CHECKPOINT_STATE_INVALID', 'The edit checkpoint is not awaiting a commit.');
    }
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
    if (!expectedStatuses.includes(current.status)) {
      throw codedError('EDIT_CHECKPOINT_STATE_INVALID', `The edit checkpoint is already ${current.status}.`);
    }
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
    if (![EDIT_CHECKPOINT_STATUSES.REVERTING, EDIT_CHECKPOINT_STATUSES.APPLIED].includes(current.status)) {
      throw codedError('EDIT_CHECKPOINT_STATE_INVALID', `The edit checkpoint is already ${current.status}.`);
    }
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
