import { TYPST_APP_PREFIX } from '../shared/constants.js';
import {
  loadSettings, saveSettings,
  sessionList, sessionCreate, sessionGet, sessionUpdate, sessionDelete,
  sessionListAllGrouped, sessionDeleteByProject, sessionImport,
  loadCustomTools, saveCustomTools,
  loadMcpServers, saveMcpServers,
  loadTheme, saveTheme
} from './storage.js';
import { handleStreamStart, abortActiveStream, generateSessionTitle, resolvePreflight } from './agent.js';
import { listMcpTools } from './mcp.js';

// ---------- Tab + side panel orchestration ----------

function isTypstAppUrl(url) {
  return typeof url === 'string' && url.startsWith(TYPST_APP_PREFIX);
}

async function syncSidePanelForTab(tabId, url) {
  if (tabId == null) return;
  try {
    if (isTypstAppUrl(url)) {
      await chrome.sidePanel.setOptions({ tabId, path: 'src/sidepanel/index.html', enabled: true });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch { /* ignore */ }
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function notifyActiveTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    broadcast({ type: 'ACTIVE_TAB_CHANGED', onTypst: isTypstAppUrl(t?.url), url: t?.url || '' });
  } catch { /* ignore */ }
}

async function refreshAllTabSidePanels() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => syncSidePanelForTab(t.id, t.url)));
  await notifyActiveTab();
}

async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://typst.app/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/isolated.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/workspace.js', 'src/content/diagnostics.js', 'src/content/main.js'],
        world: 'MAIN'
      });
    } catch { /* ignore */ }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.scripting
    .unregisterContentScripts({ ids: ['typst-agent-main', 'typst-side-agent-main'] })
    .catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: 'typst-side-agent-main',
    matches: ['https://typst.app/*'],
    js: ['src/content/workspace.js', 'src/content/diagnostics.js', 'src/content/main.js'],
    runAt: 'document_start',
    world: 'MAIN'
  }]);
  await injectIntoExistingTabs();
  await refreshAllTabSidePanels();
});

chrome.runtime.onStartup.addListener(() => { refreshAllTabSidePanels().catch(() => {}); });

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url == null && info.status !== 'complete') return;
  syncSidePanelForTab(tabId, tab.url).finally(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (active?.id === tabId) notifyActiveTab();
    });
  });
});

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    await syncSidePanelForTab(tab.id, tab.url);
  } catch { /* ignore */ }
  notifyActiveTab();
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0 || !isTypstAppUrl(details.url || '')) return;
  syncSidePanelForTab(details.tabId, details.url).finally(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (active?.id === details.tabId) notifyActiveTab();
    });
  });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- Forwarding helpers ----------

async function forwardToActiveTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isTypstAppUrl(tab.url)) throw new Error('No active typst.app tab');
  return chrome.tabs.sendMessage(tab.id, payload);
}

function respondWith(promise, sendResponse) {
  promise.then(sendResponse).catch(e => sendResponse({ error: e.message }));
}

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {
    case 'LOAD_SETTINGS':   respondWith(loadSettings(), sendResponse); return true;
    case 'SAVE_SETTINGS':   respondWith(saveSettings(msg.settings || {}), sendResponse); return true;

    case 'LOAD_THEME':      respondWith(loadTheme(), sendResponse); return true;
    case 'SAVE_THEME':      respondWith(saveTheme(msg.theme), sendResponse); return true;

    case 'SESSION_LIST':    respondWith(sessionList(msg.projectId), sendResponse); return true;
    case 'SESSION_CREATE':  respondWith(sessionCreate(msg.projectId, msg.name), sendResponse); return true;
    case 'SESSION_GET':     respondWith(sessionGet(msg.sessionId), sendResponse); return true;
    case 'SESSION_UPDATE':  respondWith(sessionUpdate(msg.sessionId, msg), sendResponse); return true;
    case 'SESSION_DELETE':  respondWith(sessionDelete(msg.sessionId), sendResponse); return true;

    case 'SESSION_LIST_ALL_GROUPED':
      respondWith(sessionListAllGrouped(), sendResponse); return true;
    case 'SESSION_DELETE_BY_PROJECT':
      respondWith(sessionDeleteByProject(msg.projectId), sendResponse); return true;
    case 'SESSION_IMPORT':
      respondWith(sessionImport(msg.records || []), sendResponse); return true;
    case 'OPEN_PROJECT_TAB':
      respondWith((async () => {
        const url = `https://typst.app/project/${encodeURIComponent(msg.projectId || '')}`;
        const tab = await chrome.tabs.create({ url });
        return { ok: true, tabId: tab?.id || null };
      })().catch(e => ({ ok: false, error: e.message })), sendResponse);
      return true;

    case 'LOAD_CUSTOM_TOOLS': respondWith(loadCustomTools(), sendResponse); return true;
    case 'SAVE_CUSTOM_TOOLS': respondWith(saveCustomTools(msg.tools || []), sendResponse); return true;

    case 'LOAD_MCP_SERVERS': respondWith(loadMcpServers(), sendResponse); return true;
    case 'SAVE_MCP_SERVERS': respondWith(saveMcpServers(msg.servers || []), sendResponse); return true;
    case 'PROBE_MCP_SERVER':
      respondWith((async () => {
        const tools = await listMcpTools(msg.server);
        return { ok: true, tools };
      })().catch(e => ({ ok: false, error: e.message })), sendResponse);
      return true;

    case 'GET_EDITOR_CONTEXT': respondWith(forwardToActiveTab({ type: 'GET_EDITOR_CONTEXT' }), sendResponse); return true;
    case 'GET_PREVIEW':
      respondWith(forwardToActiveTab({
        type: 'GET_PREVIEW',
        preferTypstCanvas: !!msg.preferTypstCanvas,
        preferAssetImage: !!msg.preferAssetImage
      }), sendResponse);
      return true;
    case 'GET_DIAGNOSTICS': respondWith(forwardToActiveTab({ type: 'GET_DIAGNOSTICS' }), sendResponse); return true;

    case 'AI_STREAM_START':  respondWith(handleStreamStart(msg), sendResponse); return true;
    case 'AI_STREAM_CANCEL': abortActiveStream(); sendResponse({ ok: true }); return false;

    case 'AI_TOOL_PREFLIGHT_RESOLVE':
      resolvePreflight(msg.callId, msg.action === 'cancel' ? 'cancel' : 'retry');
      sendResponse({ ok: true });
      return false;

    case 'GENERATE_SESSION_TITLE':
      respondWith((async () => {
        try {
          const title = await generateSessionTitle(msg.modelConfig, msg.messages || []);
          return { ok: true, title };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      })(), sendResponse);
      return true;

    case 'QUICK_ATTACH_SELECTION':
      broadcast({ type: 'QUICK_ATTACH_SELECTION' });
      if (sender.tab?.windowId != null) chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'QUICK_ATTACH_IMAGE_PREVIEW':
      broadcast({ type: 'QUICK_ATTACH_IMAGE_PREVIEW' });
      if (sender.tab?.windowId != null) chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    default: return false;
  }
});
