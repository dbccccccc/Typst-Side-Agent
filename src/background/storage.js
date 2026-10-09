/**
 * Storage facade. Every worker-owned persistence domain lives in its own store
 * under ./storage/, all sharing one adapter seam and one serialized mutation
 * queue (./storage/storage-core.js). Call sites and tests import from here so
 * the domain split does not leak into the rest of the worker.
 */
export {
  configureStorageAdapter, resetStorageAdapter, restrictStorageAccess
} from './storage/storage-core.js';
export { loadSettings, saveSettings, loadTheme, saveTheme } from './storage/settings-store.js';
export {
  loadSessions, sessionList, sessionCreate, sessionGet, sessionUpdate, sessionDelete,
  sessionListAllGrouped, sessionDeleteByProject, sessionImport, sessionExport, sessionStorageStatus
} from './storage/session-store.js';
export {
  stageEditCheckpoint, prepareEditCheckpointUpdate, commitEditCheckpoint, rollbackEditCheckpointPreparation,
  loadEditCheckpoint, loadEditCheckpointCascade, beginEditCheckpointRevert, restoreEditCheckpointApplied,
  markEditCheckpointReverted
} from './storage/checkpoint-store.js';
export {
  createDocumentSnapshot, listDocumentSnapshots, loadDocumentSnapshot, deleteDocumentSnapshot,
  deleteAutomaticDocumentSnapshots, invalidateAutomaticDocumentSnapshots
} from './storage/snapshot-store.js';
export { loadCustomTools, saveCustomTools, loadMcpServers, saveMcpServers } from './storage/integration-store.js';
