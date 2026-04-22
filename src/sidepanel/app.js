/**
 * Side panel entry point. Bootstraps state, sessions, attachments,
 * chat, and the settings panel.
 */
import { state, bg, uid, getActiveModel, resetAttachments } from './state.js';
import {
  initSettingsTabs, initThemeSwitch, applyTheme,
  initGeneralSettings, renderGeneralSettings,
  initModels, renderModelRegistry, renderModelSelector,
  initCustomTools, renderCustomToolRegistry,
  initMcpServers, renderMcpRegistry,
  initSessionsManager, renderSessionsManager, openSessionsManagerPane
} from './settings-panel.js';
import {
  setupMarkdown, renderMessages, renderUserMessage,
  createStreamingMessage, appendChunk, appendReasoning, handleToolCalls, handleToolResult,
  markPreflightWaiting, markPreflightReady,
  finalizeStream, failStream, setSendButtonStop, scrollToBottom
} from './chat.js';

const $ = id => document.getElementById(id);

let addContextMenuOpen = false;
let quickImageAttachBusy = false;

// =============================================================
// Helpers
// =============================================================

function setStatus(text = '', isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function autoResize() {
  const ta = $('user-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
}

function updateComposerLockState() {
  const lock = !state.activeTabOnTypst || state.isStreaming;
  $('user-input').disabled = lock;
  $('send-btn').disabled = !state.isStreaming && !state.activeTabOnTypst;
  $('add-context-btn').disabled = lock;
  document.querySelectorAll('.add-context-opt').forEach(b => { b.disabled = lock; });
  if (lock && addContextMenuOpen) closeAddContextMenu();
}

async function getProjectId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = tab?.url?.match(/typst\.app\/project\/([^/?#]+)/);
  return m ? m[1] : null;
}

// =============================================================
// Tab gating + project sync
// =============================================================

async function syncTabFromBrowser() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onTypst = typeof tab?.url === 'string' && tab.url.startsWith('https://typst.app/');
  state.activeTabOnTypst = onTypst;
  $('tab-gate-banner').classList.toggle('hidden', onTypst);
  updateComposerLockState();

  if (onTypst) {
    const pid = await getProjectId();
    if (pid !== state.currentProjectId) {
      state.currentProjectId = pid;
      resetAttachments();
      renderAllContextChips();
      if (pid) {
        await loadSessionsForProject(pid);
        setStatus('');
      } else {
        setStatus('Open a typst.app project to start', true);
      }
    } else if (!pid) {
      setStatus('Open a typst.app project to start', true);
    }
  } else {
    setStatus('');
  }
  autoResize();
}

// =============================================================
// Sessions
// =============================================================

async function loadSessionsForProject(projectId) {
  const sessions = await bg({ type: 'SESSION_LIST', projectId });
  if (!Array.isArray(sessions) || sessions.length === 0) {
    const s = await bg({ type: 'SESSION_CREATE', projectId, name: 'New chat' });
    await switchSession(s);
    renderSessionList([s]);
  } else {
    renderSessionList(sessions);
    await switchSession(sessions[0]);
  }
}

function renderSessionList(sessions) {
  const list = $('session-list');
  list.innerHTML = '';
  for (const s of sessions) {
    list.appendChild(buildSessionItem(s));
  }
  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:10px;font-size:11px;color:var(--text-muted);text-align:center;';
    empty.textContent = 'No chats yet';
    list.appendChild(empty);
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'dropdown-item session-item' + (state.currentSession?.id === session.id ? ' active' : '');

  const name = document.createElement('span');
  name.className = 'dropdown-item-name';
  name.textContent = session.name || 'Untitled';
  name.title = 'Open · double-click to rename';
  name.addEventListener('click', () => {
    switchSession(session);
    $('session-menu').classList.add('hidden');
  });
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    beginSessionRename(item, session);
  });

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'dropdown-item-rename';
  renameBtn.title = 'Rename';
  renameBtn.innerHTML = '✎';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    beginSessionRename(item, session);
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'dropdown-item-del';
  del.title = 'Delete';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSession(session.id);
  });

  item.appendChild(name);
  item.appendChild(renameBtn);
  item.appendChild(del);
  return item;
}

function beginSessionRename(itemEl, session) {
  if (itemEl.classList.contains('renaming')) return;
  itemEl.classList.add('renaming');

  const nameEl = itemEl.querySelector('.dropdown-item-name');
  const originalName = session.name || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'dropdown-item-rename-input';
  input.value = originalName;
  input.maxLength = 80;
  input.setAttribute('spellcheck', 'false');
  nameEl.replaceWith(input);

  input.focus();
  input.select();

  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    itemEl.classList.remove('renaming');
    const newName = input.value.trim();
    if (commit && newName && newName !== originalName) {
      await renameSession(session.id, newName);
    } else {
      // Re-render list (keeps active state / ordering).
      const sessions = await bg({ type: 'SESSION_LIST', projectId: state.currentProjectId });
      if (Array.isArray(sessions)) renderSessionList(sessions);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function renameSession(sessionId, name) {
  const updated = await bg({ type: 'SESSION_UPDATE', sessionId, name });
  if (state.currentSession?.id === sessionId) {
    state.currentSession = { ...state.currentSession, ...(updated || {}), name };
    $('session-name').textContent = name;
    state.currentSession.userRenamed = true;
  }
  const sessions = await bg({ type: 'SESSION_LIST', projectId: state.currentProjectId });
  if (Array.isArray(sessions)) renderSessionList(sessions);
}

async function switchSession(session) {
  await saveCurrentSession();
  state.currentSession = session;
  state.chatHistory = session?.messages ? [...session.messages] : [];
  $('session-name').textContent = session?.name || 'New chat';
  renderMessages();
  const sessions = await bg({ type: 'SESSION_LIST', projectId: state.currentProjectId });
  if (Array.isArray(sessions)) renderSessionList(sessions);
}

async function createNewSession() {
  if (!state.currentProjectId) {
    setStatus('Open a typst.app project first', true);
    return;
  }
  const s = await bg({ type: 'SESSION_CREATE', projectId: state.currentProjectId, name: 'New chat' });
  await switchSession(s);
  $('session-menu').classList.add('hidden');
}

async function deleteSession(sessionId) {
  await bg({ type: 'SESSION_DELETE', sessionId });
  const sessions = await bg({ type: 'SESSION_LIST', projectId: state.currentProjectId });
  if (!Array.isArray(sessions) || sessions.length === 0) {
    await createNewSession();
  } else {
    if (state.currentSession?.id === sessionId) await switchSession(sessions[0]);
    else renderSessionList(sessions);
  }
}

/**
 * Reconcile the session dropdown + active chat after the manage pane mutates
 * storage (rename / delete / bulk delete / import). Kept simple: reload the
 * current project's list, and if the active session was wiped, fall back to
 * the newest remaining one or create a fresh chat.
 */
async function reconcileAfterSessionMutation() {
  if (!state.currentProjectId) return;
  const sessions = await bg({ type: 'SESSION_LIST', projectId: state.currentProjectId });
  const list = Array.isArray(sessions) ? sessions : [];
  renderSessionList(list);

  if (state.currentSession) {
    const stillThere = list.find(s => s.id === state.currentSession.id);
    if (!stillThere) {
      if (list.length > 0) await switchSession(list[0]);
      else await createNewSession();
    } else if (stillThere.name !== state.currentSession.name) {
      state.currentSession = { ...state.currentSession, name: stillThere.name };
      $('session-name').textContent = stillThere.name;
    }
  }
}

async function saveCurrentSession() {
  if (!state.currentSession) return;
  await bg({ type: 'SESSION_UPDATE', sessionId: state.currentSession.id, messages: state.chatHistory });
}

// =============================================================
// Attachments / context chips
// =============================================================

function appendContextChip(label, onRemove, titleAttr = '') {
  const chip = document.createElement('div');
  chip.className = 'context-chip';
  const lab = document.createElement('span');
  lab.textContent = label;
  if (titleAttr) lab.title = titleAttr;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'context-chip-del';
  del.textContent = '×';
  del.addEventListener('click', onRemove);
  chip.appendChild(lab);
  chip.appendChild(del);
  $('context-attachments').appendChild(chip);
}

function renderAllContextChips() {
  const root = $('context-attachments');
  root.innerHTML = '';
  state.attachments.selections.forEach((sel, idx) => {
    const preview = (sel.text || '').replace(/\s+/g, ' ').trim().slice(0, 42);
    const label = preview
      ? `Selection ${idx + 1}: ${preview}${(sel.text || '').length > 42 ? '…' : ''}`
      : `Selection ${idx + 1}`;
    appendContextChip(label, () => {
      state.attachments.selections = state.attachments.selections.filter(s => s.id !== sel.id);
      renderAllContextChips();
    }, sel.text || '');
  });
  state.attachments.previews.forEach((pv) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-chip';
    const img = document.createElement('img');
    img.src = pv.dataUrl;
    img.alt = 'Preview';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preview-chip-del';
    del.textContent = '×';
    del.title = 'Remove preview';
    del.addEventListener('click', () => {
      state.attachments.previews = state.attachments.previews.filter(p => p.id !== pv.id);
      renderAllContextChips();
    });
    wrap.appendChild(img);
    wrap.appendChild(del);
    root.appendChild(wrap);
  });
}

function closeAddContextMenu() {
  addContextMenuOpen = false;
  $('add-context-menu').classList.add('hidden');
}

function toggleAddContextMenu() {
  if (!state.activeTabOnTypst || state.isStreaming) return;
  addContextMenuOpen = !addContextMenuOpen;
  $('add-context-menu').classList.toggle('hidden', !addContextMenuOpen);
}

/** Read the active editor selection and append it to `state.attachments.selections`. */
async function attachCurrentEditorSelection() {
  const ctx = await bg({ type: 'GET_EDITOR_CONTEXT' });
  if (ctx?.error) throw new Error(ctx.error);
  const t = (ctx.selectedText || '').trim();
  if (!t) {
    setStatus('No text selected', true);
    setTimeout(() => setStatus(''), 2000);
    return;
  }
  state.attachments.selections.push({ id: uid(), text: t });
  renderAllContextChips();
  setStatus('Selection added');
  setTimeout(() => setStatus(''), 1500);
}

async function handleAddContextAction(type) {
  closeAddContextMenu();
  if (!state.activeTabOnTypst || state.isStreaming) return;

  if (type === 'selection') {
    setStatus('Reading selection…');
    try {
      await attachCurrentEditorSelection();
    } catch (e) {
      setStatus('Selection failed: ' + e.message, true);
    }
    return;
  }

  if (type === 'preview') {
    setStatus('Capturing preview…');
    try {
      const r = await bg({ type: 'GET_PREVIEW', preferTypstCanvas: true });
      if (r?.error) throw new Error(r.error);
      state.attachments.previews.push({ id: uid(), dataUrl: r.dataUrl, captureMode: 'canvas' });
      renderAllContextChips();
      setStatus('');
    } catch (e) { setStatus('Preview failed: ' + e.message, true); }
    return;
  }

  if (type === 'opened_image') {
    setStatus('Capturing opened image…');
    try {
      const r = await bg({ type: 'GET_PREVIEW', preferAssetImage: true });
      if (r?.error) throw new Error(r.error);
      state.attachments.previews.push({ id: uid(), dataUrl: r.dataUrl, captureMode: 'asset' });
      renderAllContextChips();
      setStatus('Opened image attached');
      setTimeout(() => setStatus(''), 1500);
    } catch (e) { setStatus('Image capture failed: ' + e.message, true); }
    return;
  }
}

function getPreviewCaptureMessage(mode) {
  if (mode === 'canvas') return { type: 'GET_PREVIEW', preferTypstCanvas: true };
  if (mode === 'asset') return { type: 'GET_PREVIEW', preferAssetImage: true };
  return { type: 'GET_PREVIEW' };
}

function composeAttachmentsPayload() {
  const out = {};
  if (state.attachments.selections.length > 0) {
    out.selections = state.attachments.selections
      .map(s => ({ selectedText: s.text }))
      .filter(s => s.selectedText && s.selectedText.trim());
  }
  if (state.attachments.previews.length > 0) {
    out.previews = state.attachments.previews.map(p => ({ dataUrl: p.dataUrl }));
  }
  return out;
}

function buildSentAttachmentSnapshot(attachments) {
  return {
    selections: (attachments.selections || [])
      .map(s => ({ text: (s.selectedText || '').trim() }))
      .filter(s => s.text.length > 0),
    previews: (attachments.previews || [])
      .map(p => ({ dataUrl: p.dataUrl }))
      .filter(p => typeof p.dataUrl === 'string' && p.dataUrl.length > 0)
  };
}

function clearComposerAfterSend() {
  resetAttachments();
  renderAllContextChips();
}

async function refreshLiveAttachments() {
  if (!state.activeTabOnTypst) throw new Error('Open a typst.app tab first');
  setStatus('Refreshing attachments…');
  try {
    for (const p of state.attachments.previews) {
      const r = await bg(getPreviewCaptureMessage(p.captureMode));
      if (r?.error) throw new Error(r.error);
      p.dataUrl = r.dataUrl;
    }
    if (state.attachments.previews.length > 0) renderAllContextChips();
    setStatus('');
  } catch (e) {
    setStatus('Refresh failed: ' + e.message, true);
    throw e;
  }
}

// =============================================================
// Send
// =============================================================

async function handleSend() {
  if (state.isStreaming) {
    setStatus('Stopping…');
    await bg({ type: 'AI_STREAM_CANCEL' }).catch(() => {});
    return;
  }
  if (!state.activeTabOnTypst) return;

  const text = $('user-input').value.trim();
  if (!text) return;

  const modelConfig = getActiveModel();
  if (!modelConfig) { setStatus('Add a model in Settings first', true); return; }

  try { await refreshLiveAttachments(); } catch { return; }

  const attachments = composeAttachmentsPayload();
  const sentAttachments = buildSentAttachmentSnapshot(attachments);
  const userEntry = { role: 'user', content: text };
  if (sentAttachments.selections.length || sentAttachments.previews.length) {
    userEntry.sentAttachments = sentAttachments;
  }

  setStatus('');
  state.chatHistory.push(userEntry);
  renderUserMessage(state.chatHistory[state.chatHistory.length - 1]);
  clearComposerAfterSend();
  scrollToBottom();
  $('user-input').value = '';
  autoResize();

  const { messageEl, bodyEl } = createStreamingMessage();
  state.stream = {
    messageEl, bodyEl,
    currentContentEl: null,
    currentText: '',
    allText: '',
    currentReasoningEl: null,
    currentReasoningText: '',
    allReasoning: '',
    toolCalls: [],
    segments: []
  };
  state.isStreaming = true;
  updateComposerLockState();
  setSendButtonStop(true);

  bg({
    type: 'AI_STREAM_START',
    messages: state.chatHistory,
    settings: state.settings,
    modelConfig,
    attachments
  }).then(r => {
    if (r?.ok === false && state.isStreaming) failStream(r.error, setStatus);
  }).catch(e => {
    if (state.isStreaming) failStream(e.message, setStatus);
  });

  await saveCurrentSession();
}

function onStreamFinalize() {
  saveCurrentSession();
  setStatus('');
  $('user-input').focus();
  updateComposerLockState();
  maybeAutoNameSession().catch(() => { /* silent; naming is best-effort */ });
}

function isDefaultSessionName(name) {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  return n === '' || n === 'new chat' || n === 'untitled';
}

async function maybeAutoNameSession() {
  const session = state.currentSession;
  if (!session) return;
  if (session.userRenamed) return;
  if (!isDefaultSessionName(session.name)) return;

  const modelId = state.settings.autoNameModelId;
  if (!modelId) return;
  const modelConfig = state.settings.models.find(m => m.id === modelId);
  if (!modelConfig) return;

  // Need at least one assistant reply before we try to name.
  const hasAssistant = state.chatHistory.some(m => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  if (!hasAssistant) return;

  // Build a light-weight message slice for the namer (strip attachments/segments).
  const slim = state.chatHistory
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
    .filter(m => m.content);

  const r = await bg({ type: 'GENERATE_SESSION_TITLE', modelConfig, messages: slim });
  if (!r?.ok || !r.title) return;

  // User may have renamed while we were waiting — bail out if so.
  if (state.currentSession?.id !== session.id) return;
  if (state.currentSession.userRenamed) return;
  if (!isDefaultSessionName(state.currentSession.name)) return;

  await bg({ type: 'SESSION_UPDATE', sessionId: session.id, name: r.title });
  state.currentSession.name = r.title;
  $('session-name').textContent = r.title;
  const sessions = await bg({ type: 'SESSION_LIST', projectId: state.currentProjectId });
  if (Array.isArray(sessions)) renderSessionList(sessions);
}

// =============================================================
// Theme + load
// =============================================================

async function loadTheme() {
  try {
    const t = await bg({ type: 'LOAD_THEME' });
    applyTheme(t || 'dark');
  } catch {
    applyTheme('dark');
  }
}

async function loadAllRegistries() {
  const [settings, customTools, mcpServers] = await Promise.all([
    bg({ type: 'LOAD_SETTINGS' }),
    bg({ type: 'LOAD_CUSTOM_TOOLS' }),
    bg({ type: 'LOAD_MCP_SERVERS' })
  ]);

  if (settings && !settings.error) {
    state.settings = {
      systemPrompt: settings.systemPrompt || '',
      models: Array.isArray(settings.models) ? settings.models : [],
      activeModelId: settings.activeModelId || null,
      maxHistoryMessages: settings.maxHistoryMessages || 40,
      autoNameModelId: settings.autoNameModelId ?? null
    };
  }
  state.customTools = Array.isArray(customTools) ? customTools : [];
  state.mcpServers = Array.isArray(mcpServers) ? mcpServers : [];

  renderGeneralSettings();
  renderModelRegistry();
  renderModelSelector();
  renderCustomToolRegistry();
  renderMcpRegistry();
}

// =============================================================
// Quick attach (from page float buttons)
// =============================================================

async function quickAttachSelection() {
  if (!state.activeTabOnTypst) return;
  try {
    await attachCurrentEditorSelection();
  } catch (e) {
    setStatus('Quick attach failed: ' + e.message, true);
  }
}

async function quickAttachImagePreview() {
  if (!state.activeTabOnTypst) return;
  if (quickImageAttachBusy) return;
  quickImageAttachBusy = true;
  try {
    setStatus('Capturing preview image…');
    const r = await bg({ type: 'GET_PREVIEW' });
    if (r?.error) throw new Error(r.error);
    if (!r?.dataUrl) throw new Error('No image data');
    state.attachments.previews.push({ id: uid(), dataUrl: r.dataUrl, captureMode: 'auto' });
    renderAllContextChips();
    setStatus('Image added');
    setTimeout(() => setStatus(''), 1500);
  } catch (e) {
    setStatus('Image attach failed: ' + e.message, true);
    setTimeout(() => setStatus(''), 3000);
  } finally {
    quickImageAttachBusy = false;
  }
}

// =============================================================
// Wiring
// =============================================================

function wireRuntimeMessages() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    switch (msg.type) {
      case 'AI_STREAM_CHUNK':     appendChunk(msg.text); break;
      case 'AI_STREAM_REASONING': appendReasoning(msg.text); break;
      case 'AI_STREAM_DONE':
        if (state.isStreaming) finalizeStream(onStreamFinalize);
        break;
      case 'AI_STREAM_ERROR': failStream(msg.error, setStatus); break;
      case 'AI_TOOL_CALLS':   handleToolCalls(msg.calls || []); break;
      case 'AI_TOOL_RESULT':  handleToolResult(msg.callId, msg.name, msg.result); break;
      case 'AI_TOOL_PREFLIGHT_WAITING': markPreflightWaiting(msg); break;
      case 'AI_TOOL_PREFLIGHT_READY':   markPreflightReady(msg.callId); break;
      case 'ACTIVE_TAB_CHANGED': syncTabFromBrowser().catch(() => {}); break;
      case 'QUICK_ATTACH_SELECTION': quickAttachSelection(); break;
      case 'QUICK_ATTACH_IMAGE_PREVIEW': quickAttachImagePreview(); break;
    }
  });
}

function wireUi() {
  // Header dropdowns
  $('session-current').addEventListener('click', () => $('session-menu').classList.toggle('hidden'));
  $('session-new').addEventListener('click', () => createNewSession());
  $('session-manage').addEventListener('click', () => {
    $('session-menu').classList.add('hidden');
    openSessionsManagerPane().catch(() => {});
  });
  $('model-current').addEventListener('click', () => $('model-menu').classList.toggle('hidden'));

  // Outside click closers
  document.addEventListener('click', (e) => {
    if (!$('session-dropdown').contains(e.target)) $('session-menu').classList.add('hidden');
    if (!$('model-selector').contains(e.target)) $('model-menu').classList.add('hidden');
    const wrap = $('add-context-wrap');
    if (wrap && !wrap.contains(e.target)) closeAddContextMenu();
  });

  // Settings panel
  $('settings-toggle').addEventListener('click', () => {
    const collapsed = $('settings-panel').classList.toggle('collapsed');
    $('settings-toggle').classList.toggle('active', !collapsed);
  });

  // Add context menu
  $('add-context-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddContextMenu();
  });
  document.querySelectorAll('.add-context-opt[data-add]').forEach(btn => {
    btn.addEventListener('click', () => handleAddContextAction(btn.dataset.add));
  });

  // Composer
  $('send-btn').addEventListener('click', (e) => { e.preventDefault(); handleSend(); });
  $('user-input').addEventListener('input', autoResize);
  $('user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
}

// =============================================================
// Init
// =============================================================

async function init() {
  setupMarkdown();
  setSendButtonStop(false);

  initSettingsTabs();
  initThemeSwitch();
  initGeneralSettings(() => { /* settings re-render handled inside */ });
  initModels(() => renderModelSelector());
  initCustomTools();
  initMcpServers();
  initSessionsManager({
    onSessionsChanged: () => { reconcileAfterSessionMutation().catch(() => {}); },
    onSwitchToSession: async (session) => {
      if (!session?.projectId || session.projectId !== state.currentProjectId) return;
      await switchSession(session);
      $('session-menu').classList.add('hidden');
    }
  });

  await loadTheme();
  await loadAllRegistries();

  if (!state.settings.models || state.settings.models.length === 0) {
    $('settings-panel').classList.remove('collapsed');
    $('settings-toggle').classList.add('active');
    const tabs = document.querySelectorAll('.settings-tab');
    const panes = document.querySelectorAll('.settings-tab-pane');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'models'));
    panes.forEach(p => p.classList.toggle('active', p.dataset.pane === 'models'));
  }

  wireRuntimeMessages();
  wireUi();

  await syncTabFromBrowser();
  renderMessages();
}

document.addEventListener('DOMContentLoaded', init);
