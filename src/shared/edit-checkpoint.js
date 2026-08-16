export const EDIT_CHECKPOINT_STATUSES = Object.freeze({
  PREPARED: 'prepared',
  APPLIED: 'applied',
  REVERTING: 'reverting',
  REVERTED: 'reverted'
});

export const DEFAULT_EDIT_FILE_LABEL = 'Current Typst document';

const PUBLIC_STATUSES = new Set([
  EDIT_CHECKPOINT_STATUSES.APPLIED,
  EDIT_CHECKPOINT_STATUSES.REVERTED,
  'unavailable'
]);

const EDIT_CHECKPOINT_TOOL_NAMES = new Set([
  'replace_lines',
  'search_replace',
  'patch_document',
  'insert_at_cursor',
  'replace_selection'
]);

export function isEditCheckpointToolName(name) {
  return EDIT_CHECKPOINT_TOOL_NAMES.has(name);
}

/** Return the last valid built-in editor checkpoint receipt in a display message. */
export function latestEditCheckpointFromMessage(message) {
  let latest = null;
  for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
    if (segment?.type !== 'tools') continue;
    for (const call of Array.isArray(segment.calls) ? segment.calls : []) {
      if (!isEditCheckpointToolName(call?.name)) continue;
      const checkpoint = normalizePublicEditCheckpoint(segment.results?.[call.id]?.editCheckpoint);
      if (checkpoint) latest = checkpoint;
    }
  }
  return latest;
}

export function applyTextChanges(text, changes) {
  if (typeof text !== 'string' || !Array.isArray(changes)) throw new TypeError('Text changes require a string and an array.');
  let cursor = 0;
  let output = '';
  for (const change of changes) {
    if (!change || !Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < cursor || change.to < change.from || change.to > text.length || typeof change.insert !== 'string') {
      throw new TypeError('Text changes must be sorted, non-overlapping, and within the source text.');
    }
    output += text.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return output + text.slice(cursor);
}

export async function sha256Text(text, cryptoImpl = globalThis.crypto) {
  if (typeof text !== 'string') throw new TypeError('Text hash input must be a string.');
  if (!cryptoImpl?.subtle?.digest) throw new Error('SHA-256 is unavailable in this runtime.');
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function publicEditCheckpoint(record) {
  if (!record || typeof record !== 'object') return null;
  const status = PUBLIC_STATUSES.has(record.status) ? record.status : null;
  if (!validId(record.id) || !status) return null;
  return {
    id: record.id,
    status,
    fileLabel: boundedString(record.fileLabel || DEFAULT_EDIT_FILE_LABEL, 240),
    createdAt: Number.isFinite(record.createdAt) && record.createdAt >= 0 ? record.createdAt : Date.now()
  };
}

export function normalizePublicEditCheckpoint(value, { imported = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) return null;
  if (!PUBLIC_STATUSES.has(value.status)) return null;
  const status = imported
    ? 'unavailable'
    : value.status;
  return {
    id: value.id,
    status,
    fileLabel: boundedString(value.fileLabel || DEFAULT_EDIT_FILE_LABEL, 240),
    createdAt: Number.isFinite(value.createdAt) && value.createdAt >= 0 ? value.createdAt : Date.now(),
    ...(status === 'unavailable' ? {
      unavailableReason: boundedString(
        imported ? 'Revert data is not included in session exports.' : value.unavailableReason || 'Revert data is unavailable.',
        300
      )
    } : {})
  };
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function boundedString(value, max) {
  return String(value ?? '').slice(0, max);
}
