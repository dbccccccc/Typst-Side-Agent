import { TYPST_APP_PREFIX } from '../shared/constants.js';
import {
  PROTOCOL, buildRequest, errorResponse, successResponse,
  unwrapResponse, validateEnvelope, validateRunCancelEnvelope, validateRunReserveEnvelope, validateRunStartEnvelope
} from '../shared/protocol.js';
import {
  loadSettings, saveSettings,
  sessionList, sessionCreate, sessionGet, sessionUpdate, sessionDelete,
  sessionListAllGrouped, sessionDeleteByProject, sessionImport, sessionExport,
  sessionStorageStatus, loadCustomTools, saveCustomTools,
  loadMcpServers, saveMcpServers, loadTheme, saveTheme, restrictStorageAccess
} from './storage.js';
import { handleStreamStart, reserveRun, abortRun, generateSessionTitle, getActiveRunSummaries, resolvePreflight, resolveApproval } from './agent.js';
import { listMcpToolsDetailed } from './mcp.js';
import { ensureMainWorldRegistration, injectIntoExistingTypstTabs } from './content-bootstrap.js';
import { quickAttachSource } from '../shared/quick-attach.js';
import { revertEditCheckpoint } from './edit-revert.js';
import {
  deleteDocumentSnapshotForEditor, listDocumentSnapshotsForEditor,
  previewDocumentSnapshotRestore, restoreDocumentSnapshot
} from './document-snapshots.js';

const revertingTabs = new Set();
const snapshotMutationTabs = new Set();

async function handleEditCheckpointRevert(payload) {
  if (revertingTabs.has(payload.tabId) || snapshotMutationTabs.has(payload.tabId)) throw coded('EDIT_REVERT_ACTIVE', 'A document recovery operation is already running on this tab.');
  revertingTabs.add(payload.tabId);
  try {
    return await revertEditCheckpoint(payload, { activeRuns: getActiveRunSummaries() });
  } finally {
    revertingTabs.delete(payload.tabId);
  }
}

async function handleSnapshotMutation(payload, operation) {
  if (revertingTabs.has(payload.tabId) || snapshotMutationTabs.has(payload.tabId)) {
    throw coded('DOCUMENT_SNAPSHOT_ACTIVE', 'A document recovery operation is already running on this tab.');
  }
  snapshotMutationTabs.add(payload.tabId);
  try {
    return await operation(payload, { activeRuns: getActiveRunSummaries() });
  } finally {
    snapshotMutationTabs.delete(payload.tabId);
  }
}

function isTypstAppUrl(url) {
  return typeof url === 'string' && url.startsWith(TYPST_APP_PREFIX);
}

async function syncSidePanelForTab(tabId, url) {
  if (tabId == null) return;
  try {
    if (isTypstAppUrl(url)) await chrome.sidePanel.setOptions({ tabId, path: 'src/sidepanel/index.html', enabled: true });
    else await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch { /* tab may have closed */ }
}

function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage(buildRequest(type, payload)).catch(() => {});
}

const pendingQuickAttaches = [];
const QUICK_ATTACH_TTL_MS = 30_000;

function pruneQuickAttaches() {
  const cutoff = Date.now() - QUICK_ATTACH_TTL_MS;
  while (pendingQuickAttaches.length && pendingQuickAttaches[0].createdAt < cutoff) pendingQuickAttaches.shift();
  while (pendingQuickAttaches.length > 32) pendingQuickAttaches.shift();
}

async function dispatchQuickAttach(type, sender) {
  const source = quickAttachSource(sender);
  if (!source) throw coded('QUICK_ATTACH_SOURCE_MISSING', 'Quick attachment requires an originating tab and window.');
  const payload = { ...source, eventId: `quick-${crypto.randomUUID()}` };
  pendingQuickAttaches.push({ type, payload, createdAt: Date.now() });
  pruneQuickAttaches();
  await chrome.sidePanel.open({ windowId: source.windowId });
  broadcast(type, payload);
  return { ok: true, eventId: payload.eventId };
}

function drainQuickAttaches(windowId) {
  pruneQuickAttaches();
  const drained = pendingQuickAttaches.filter(item => item.payload.windowId === windowId).map(({ type, payload }) => ({ type, payload }));
  for (let index = pendingQuickAttaches.length - 1; index >= 0; index -= 1) {
    if (pendingQuickAttaches[index].payload.windowId === windowId) pendingQuickAttaches.splice(index, 1);
  }
  return drained;
}

async function notifyActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    broadcast(PROTOCOL.ACTIVE_TAB_CHANGED, { onTypst: isTypstAppUrl(tab?.url), url: tab?.url || '', tabId: tab?.id ?? null });
  } catch { /* browser is shutting down */ }
}

async function refreshAllTabSidePanels() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => syncSidePanelForTab(tab.id, tab.url)));
  await notifyActiveTab();
}

let bootstrapInFlight = null;

function bootstrapExtension() {
  if (bootstrapInFlight) return bootstrapInFlight;
  bootstrapInFlight = (async () => {
    await ensureMainWorldRegistration(chrome.scripting);
    await restrictStorageAccess();
    await injectIntoExistingTypstTabs(chrome.tabs, chrome.scripting);
    await refreshAllTabSidePanels();
  })().finally(() => { bootstrapInFlight = null; });
  return bootstrapInFlight;
}

function scheduleBootstrap() {
  bootstrapExtension().catch(error => console.warn('Typst Side Agent bootstrap failed:', error));
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleBootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleBootstrap();
});

// Unpacked-extension Reload does not reliably re-run onInstalled. Repair the
// persisted dynamic registration and every already-open Typst tab on each
// fresh service-worker instance instead.
scheduleBootstrap();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url == null && info.status !== 'complete') return;
  syncSidePanelForTab(tabId, tab.url).finally(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (active?.id === tabId) notifyActiveTab();
    });
  });
});

chrome.tabs.onActivated.addListener(async info => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    await syncSidePanelForTab(tab.id, tab.url);
  } catch { /* closed tab */ }
  await notifyActiveTab();
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0 || !isTypstAppUrl(details.url)) return;
  syncSidePanelForTab(details.tabId, details.url).finally(notifyActiveTab);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function activeTypstTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isTypstAppUrl(tab.url)) throw coded('NO_TYPST_TAB', 'No active typst.app tab.');
  return tab;
}

async function forwardToActiveTab(type, payload = {}) {
  const tab = await activeTypstTab();
  const response = await chrome.tabs.sendMessage(tab.id, buildRequest(type, payload));
  return unwrapResponse(response);
}

async function forwardToSelectedTab(tabId, type, payload = {}) {
  if (tabId == null) return forwardToActiveTab(type, payload);
  if (!Number.isInteger(tabId) || tabId < 0) throw coded('INVALID_TAB_ID', 'tabId must be a non-negative integer.');
  const tab = await chrome.tabs.get(tabId);
  if (!isTypstAppUrl(tab?.url)) throw coded('NOT_TYPST_TAB', 'The selected tab is not a typst.app page.');
  const response = await chrome.tabs.sendMessage(tabId, buildRequest(type, payload));
  return unwrapResponse(response);
}

function respond(sendResponse, request, promise) {
  Promise.resolve(promise).then(
    data => sendResponse(successResponse(request.requestId, data, request.runId)),
    error => sendResponse(errorResponse(request.requestId, {
      code: error?.code || 'REQUEST_FAILED',
      message: error?.message || String(error),
      details: error?.details
    }, request.runId))
  );
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const checked = validateEnvelope(message);
  if (!checked.ok) {
    if (typeof message?.requestId === 'string') sendResponse(errorResponse(message.requestId, checked.error, message.runId));
    return false;
  }
  const payload = message.payload;
  switch (message.type) {
    case PROTOCOL.LOAD_SETTINGS: return respond(sendResponse, message, loadSettings());
    case PROTOCOL.SAVE_SETTINGS: return respond(sendResponse, message, saveSettings(payload.settings || {}, {
      fields: payload.fields,
      modelMutation: payload.modelMutation
    }));
    case PROTOCOL.LOAD_THEME: return respond(sendResponse, message, loadTheme());
    case PROTOCOL.SAVE_THEME: return respond(sendResponse, message, saveTheme(payload.theme));

    case PROTOCOL.SESSION_LIST: return respond(sendResponse, message, sessionList(payload.projectId));
    case PROTOCOL.SESSION_CREATE: return respond(sendResponse, message, sessionCreate(payload.projectId, payload.name));
    case PROTOCOL.SESSION_GET: return respond(sendResponse, message, sessionGet(payload.sessionId));
    case PROTOCOL.SESSION_UPDATE: return respond(sendResponse, message, sessionUpdate(payload.sessionId, payload));
    case PROTOCOL.SESSION_DELETE: return respond(sendResponse, message, sessionDelete(payload.sessionId));
    case PROTOCOL.SESSION_LIST_ALL_GROUPED: return respond(sendResponse, message, sessionListAllGrouped());
    case PROTOCOL.SESSION_DELETE_BY_PROJECT: return respond(sendResponse, message, sessionDeleteByProject(payload.projectId));
    case PROTOCOL.SESSION_IMPORT: return respond(sendResponse, message, sessionImport(payload.exportData ?? payload.records ?? []));
    case PROTOCOL.SESSION_EXPORT: return respond(sendResponse, message, sessionExport());
    case PROTOCOL.SESSION_STORAGE_STATUS: return respond(sendResponse, message, sessionStorageStatus());
    case PROTOCOL.EDIT_CHECKPOINT_REVERT:
      return respond(sendResponse, message, handleEditCheckpointRevert(payload));
    case PROTOCOL.DOCUMENT_SNAPSHOT_LIST:
      return respond(sendResponse, message, listDocumentSnapshotsForEditor(payload));
    case PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW:
      return respond(sendResponse, message, previewDocumentSnapshotRestore(payload, { activeRuns: getActiveRunSummaries() }));
    case PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE:
      return respond(sendResponse, message, handleSnapshotMutation(payload, restoreDocumentSnapshot));
    case PROTOCOL.DOCUMENT_SNAPSHOT_DELETE:
      return respond(sendResponse, message, handleSnapshotMutation(payload, deleteDocumentSnapshotForEditor));

    case PROTOCOL.OPEN_PROJECT_TAB:
      return respond(sendResponse, message, chrome.tabs.create({ url: `https://typst.app/project/${encodeURIComponent(payload.projectId || '')}` }).then(tab => ({ ok: true, tabId: tab?.id || null })));

    case PROTOCOL.LOAD_CUSTOM_TOOLS: return respond(sendResponse, message, loadCustomTools());
    case PROTOCOL.SAVE_CUSTOM_TOOLS: return respond(sendResponse, message, saveCustomTools(payload.tools || [], payload.mutation));
    case PROTOCOL.LOAD_MCP_SERVERS: return respond(sendResponse, message, loadMcpServers());
    case PROTOCOL.SAVE_MCP_SERVERS: return respond(sendResponse, message, saveMcpServers(payload.servers || [], payload.mutation));
    case PROTOCOL.PROBE_MCP_SERVER:
      return respond(sendResponse, message, listMcpToolsDetailed(payload.server, null, { forceRefresh: true }).then(detail => ({ ok: true, ...detail })));

    case PROTOCOL.GET_EDITOR_CONTEXT: {
      const { tabId, ...contextOptions } = payload;
      return respond(sendResponse, message, forwardToSelectedTab(tabId, PROTOCOL.PAGE_GET_CONTEXT, contextOptions));
    }
    case PROTOCOL.GET_PREVIEW: return respond(sendResponse, message, forwardToSelectedTab(payload.tabId, PROTOCOL.PAGE_GET_PREVIEW, payload));
    case PROTOCOL.GET_DIAGNOSTICS: return respond(sendResponse, message, forwardToSelectedTab(payload.tabId, PROTOCOL.PAGE_GET_DIAGNOSTICS));

    case PROTOCOL.AI_RUN_RESERVE: {
      const valid = validateRunReserveEnvelope(message);
      if (!valid.ok) return respond(sendResponse, message, Promise.reject(coded(valid.error.code, valid.error.message)));
      if (revertingTabs.has(payload.tabId) || snapshotMutationTabs.has(payload.tabId)) return respond(sendResponse, message, Promise.reject(coded('DOCUMENT_RECOVERY_ACTIVE', 'Wait for the active document recovery operation on this tab to finish before starting an agent run.')));
      return respond(sendResponse, message, Promise.resolve().then(() => reserveRun(message)));
    }
    case PROTOCOL.AI_STREAM_START: {
      const valid = validateRunStartEnvelope(message);
      if (!valid.ok) return respond(sendResponse, message, Promise.reject(coded(valid.error.code, valid.error.message)));
      if (revertingTabs.has(payload.tabId) || snapshotMutationTabs.has(payload.tabId)) return respond(sendResponse, message, Promise.reject(coded('DOCUMENT_RECOVERY_ACTIVE', 'Wait for the active document recovery operation on this tab to finish before starting an agent run.')));
      return respond(sendResponse, message, handleStreamStart(message));
    }
    case PROTOCOL.AI_STREAM_CANCEL: {
      const valid = validateRunCancelEnvelope(message);
      if (!valid.ok) return respond(sendResponse, message, Promise.reject(coded(valid.error.code, valid.error.message)));
      return respond(sendResponse, message, abortRun(message.runId));
    }
    case PROTOCOL.AI_RUN_STATUS:
      return respond(sendResponse, message, getActiveRunSummaries().filter(run => run.projectId === payload.projectId && run.sessionId === payload.sessionId));
    case PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE:
      return respond(sendResponse, message, { ok: resolvePreflight(message.runId, payload.callId, payload.action) });
    case PROTOCOL.AI_TOOL_APPROVAL_RESOLVE:
      return respond(sendResponse, message, { ok: resolveApproval(message.runId, payload.callId, payload.action) });

    case PROTOCOL.GENERATE_SESSION_TITLE:
      return respond(sendResponse, message, generateSessionTitle(payload.modelConfig, payload.messages || []).then(title => ({ ok: true, title })));

    case PROTOCOL.QUICK_ATTACH_SELECTION:
      return respond(sendResponse, message, dispatchQuickAttach(PROTOCOL.QUICK_ATTACH_SELECTION, sender));
    case PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW:
      return respond(sendResponse, message, dispatchQuickAttach(PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW, sender));
    case PROTOCOL.QUICK_ATTACH_DRAIN:
      return respond(sendResponse, message, drainQuickAttaches(payload.windowId));
    default:
      sendResponse(errorResponse(message.requestId, { code: 'UNROUTED_MESSAGE', message: `No route for ${message.type}` }, message.runId));
      return false;
  }
});

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
