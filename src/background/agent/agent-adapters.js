/**
 * Injectable adapters for every side effect the agent performs. Tests replace
 * these to drive full runs without Chrome, network, or storage. Modules import
 * the live `adapters` binding so a reconfiguration applies everywhere at once.
 */
import {
  commitEditCheckpoint, createDocumentSnapshot, deleteAutomaticDocumentSnapshots,
  invalidateAutomaticDocumentSnapshots, loadCustomTools, loadMcpServers, prepareEditCheckpointUpdate,
  rollbackEditCheckpointPreparation, stageEditCheckpoint
} from '../storage.js';
import { callMcpTool, listMcpToolsDetailed } from '../mcp.js';
import { persistRunTranscriptToStorage } from './run-transcript.js';

export function defaultAdapters() {
  const storageAvailable = !!globalThis.chrome?.storage?.local;
  return {
    fetchImpl: (...args) => fetch(...args),
    runtimeSend: message => chrome.runtime.sendMessage(message).catch(() => {}),
    tabsSend: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    tabsGet: tabId => chrome.tabs.get(tabId),
    loadCustomTools,
    loadMcpServers,
    stageEditCheckpoint,
    prepareEditCheckpointUpdate,
    commitEditCheckpoint,
    rollbackEditCheckpointPreparation,
    createDocumentSnapshot,
    deleteAutomaticDocumentSnapshots,
    invalidateAutomaticDocumentSnapshots,
    documentSnapshotsEnabled: () => !!globalThis.chrome?.storage?.local,
    listMcpToolsDetailed,
    callMcpTool,
    persistRunTranscript: storageAvailable ? persistRunTranscriptToStorage : async () => {},
    setTimeoutImpl: (...args) => setTimeout(...args),
    clearTimeoutImpl: id => clearTimeout(id),
    now: () => Date.now()
  };
}

export let adapters = defaultAdapters();

export function configureAgentAdapters(overrides = {}) {
  adapters = { ...defaultAdapters(), ...overrides };
}
