export const DOCUMENT_SNAPSHOT_KINDS = Object.freeze({
  MANUAL: 'manual',
  AUTOMATIC: 'automatic',
  RESCUE: 'rescue'
});

export const SNAPSHOT_RESTORED_UPDATE_KIND = 'snapshot-restored';

const SNAPSHOT_KIND_SET = new Set(Object.values(DOCUMENT_SNAPSHOT_KINDS));

export function publicDocumentSnapshot(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (!validId(record.id) || !SNAPSHOT_KIND_SET.has(record.kind)) return null;
  if (typeof record.projectId !== 'string' || !record.projectId || record.projectId.length > 256) return null;
  const fileLabel = boundedString(record.fileLabel, 240);
  if (!fileLabel) return null;
  return {
    id: record.id,
    kind: record.kind,
    projectId: record.projectId,
    fileLabel,
    title: boundedString(record.title || defaultSnapshotTitle(record.kind), 120),
    createdAt: finiteTimestamp(record.createdAt),
    textLength: Number.isInteger(record.textLength) && record.textLength >= 0 ? record.textLength : 0,
    ...(record.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && validId(record.sessionId)
      ? { sessionId: record.sessionId }
      : {})
  };
}

export function normalizePublicDocumentSnapshot(value) {
  return publicDocumentSnapshot(value);
}

export function createSnapshotRestoredEditorUpdate(snapshot, timestamp = Date.now()) {
  const normalized = publicDocumentSnapshot(snapshot);
  if (!normalized) return null;
  return {
    kind: SNAPSHOT_RESTORED_UPDATE_KIND,
    snapshotId: normalized.id,
    fileLabel: normalized.fileLabel,
    restoredAt: finiteTimestamp(timestamp)
  };
}

/** Imported history cannot assert trusted local editor-state transitions. */
export function normalizeEditorStateUpdate(value, options = {}) {
  if (options.imported || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind !== SNAPSHOT_RESTORED_UPDATE_KIND || !validId(value.snapshotId)) return null;
  const fileLabel = boundedString(value.fileLabel, 240);
  if (!fileLabel) return null;
  return {
    kind: SNAPSHOT_RESTORED_UPDATE_KIND,
    snapshotId: value.snapshotId,
    fileLabel,
    restoredAt: finiteTimestamp(value.restoredAt)
  };
}

export function defaultSnapshotTitle(kind) {
  if (kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC) return 'After latest response';
  if (kind === DOCUMENT_SNAPSHOT_KINDS.RESCUE) return 'Before restore';
  return 'Manual snapshot';
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function boundedString(value, max) {
  return String(value ?? '').slice(0, max);
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}
