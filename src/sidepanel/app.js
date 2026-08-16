/**
 * Side panel entry point. Bootstraps state, sessions, attachments,
 * chat, and the settings panel.
 */
import { state, bg, uid, getActiveModel } from './state.js';
import { PROTOCOL, createRunId, validateEnvelope } from '../shared/protocol.js';
import { normalizeEditorApprovalMode, normalizeSendMessageShortcut } from '../shared/constants.js';
import { isQuickAttachForPanel } from '../shared/quick-attach.js';
import { createSessionController } from './session-controller.js';
import { createAttachmentController } from './attachment-controller.js';
import { createRunUiController } from './run-ui-controller.js';
import { createTransitionCoordinator } from './transition-coordinator.js';
import { setStatus } from './status-controller.js';
import { sendMessageShortcutLabel, shouldSendMessageForKey } from './composer-shortcut.js';
import { normalizeEditorStateUpdate } from '../shared/document-snapshot.js';
import { activeEditorFileFromContext } from '../shared/active-file.js';
import { renderEditDiffPreview } from './edit-diff.js';
import { createSnapshotController } from './snapshot-controller.js';
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
  markPreflightWaiting, markPreflightReady, markApprovalRequired,
  finalizeStream, failStream, flushPendingRender, setSendButtonStop, scrollToBottom,
  configureResponseRecoveryActions, resetRevertConfirmation
} from './chat.js';

const $ = id => document.getElementById(id);
const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/detail/eljacjoifoamnmbclmhlpcdabdioleab';

let addContextMenuOpen = false;
let editorPermissionMenuOpen = false;
let aboutDialogTrigger = null;
let quickImageAttachBusy = false;
let editorPermissionSavePending = false;
let panelReadyForQuickAttach = false;
let quickAttachDeliveryQueue = Promise.resolve();
const autoNameGenerationBySession = new Map();
const queuedQuickAttaches = [];
const seenQuickAttachIds = new Set();
const sessionController = createSessionController({ request: bg, state });
const attachmentController = createAttachmentController({ state, request: bg, makeId: uid });
const runUiController = createRunUiController({ state });
const transitions = createTransitionCoordinator();
const snapshotController = createSnapshotController({
  request: bg,
  getScope: () => ({
    tabId: state.activeTabId,
    projectId: state.currentProjectId,
    sessionId: state.currentSession?.id || null
  }),
  isLocked: () => !state.activeTabOnTypst || state.isStreaming || transitions.hasActiveSend() || !state.currentProjectId || state.currentSession?.projectId !== state.currentProjectId,
  setStatus,
  renderDiff: renderEditDiffPreview,
  onRestored: persistSnapshotRestoreContext,
  onBeforeOpen: () => {
    closeAddContextMenu();
    closeEditorPermissionMenu();
  }
});
configureResponseRecoveryActions({
  openSnapshots: trigger => snapshotController.openFor(trigger).catch(error => {
    setStatus(error?.message || String(error), true);
  })
});

// =============================================================
// Helpers
// =============================================================

function autoResize() {
  const ta = $('user-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
}

function renderSendMessageShortcut() {
  const shortcut = normalizeSendMessageShortcut(state.settings.sendMessageShortcut);
  state.settings.sendMessageShortcut = shortcut;
  const label = sendMessageShortcutLabel(shortcut);
  const hint = $('send-shortcut-hint');
  if (hint) hint.textContent = label;
  const send = $('send-btn');
  if (send) {
    send.title = `Send message (${label})`;
    send.setAttribute('aria-label', `Send message (${label})`);
  }
}

function renderEditorApprovalMode() {
  const mode = normalizeEditorApprovalMode(state.settings.editorApprovalMode);
  state.settings.editorApprovalMode = mode;
  document.querySelectorAll('[data-editor-approval-mode]').forEach(button => {
    const active = button.dataset.editorApprovalMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
  const current = $('editor-permission-current');
  if (current) current.textContent = mode === 'auto' ? 'Auto' : 'Ask';
  const trigger = $('editor-permission-btn');
  if (trigger) {
    trigger.dataset.mode = mode;
    trigger.setAttribute('aria-label', mode === 'auto'
      ? 'Document edits: auto approve'
      : 'Document edits: ask before applying');
    trigger.title = mode === 'auto'
      ? 'Built-in document edits apply automatically'
      : 'Review document edits before they are applied';
  }
}

function setSettingsOpen(open) {
  $('settings-panel').classList.toggle('collapsed', !open);
  $('settings-toggle').classList.toggle('active', open);
  $('settings-toggle').setAttribute('aria-expanded', String(open));
}

function configureAboutUi() {
  const manifest = chrome.runtime.getManifest();
  const versionLabel = `Version ${manifest.version}`;
  $('about-settings-version').textContent = versionLabel;
  $('about-dialog-version').textContent = versionLabel;
  $('about-chrome-store-link').href = CHROME_WEB_STORE_URL;
}

function openAboutDialog(trigger) {
  closeAddContextMenu();
  closeEditorPermissionMenu();
  $('session-menu').classList.add('hidden');
  $('model-menu').classList.add('hidden');
  aboutDialogTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  $('about-dialog-layer').classList.remove('hidden');
  $('about-dialog-close').focus();
}

function closeAboutDialog({ restoreFocus = true } = {}) {
  const layer = $('about-dialog-layer');
  if (layer.classList.contains('hidden')) return;
  layer.classList.add('hidden');
  const trigger = aboutDialogTrigger;
  aboutDialogTrigger = null;
  if (restoreFocus && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
}

async function setEditorApprovalMode(value) {
  const next = normalizeEditorApprovalMode(value);
  const previous = normalizeEditorApprovalMode(state.settings.editorApprovalMode);
  if (next === previous || editorPermissionSavePending || state.isStreaming) return;

  editorPermissionSavePending = true;
  state.settings.editorApprovalMode = next;
  renderEditorApprovalMode();
  updateComposerLockState();
  try {
    const saved = await bg({
      type: PROTOCOL.SAVE_SETTINGS,
      settings: state.settings,
      fields: ['editorApprovalMode']
    });
    if (saved?.settings) state.settings = saved.settings;
    setStatus(next === 'auto' ? 'Editor edits will auto-approve' : 'Editor edits will ask first', false, 1500);
  } catch (error) {
    state.settings.editorApprovalMode = previous;
    renderEditorApprovalMode();
    setStatus(`Permission setting was not saved: ${error.message}`, true);
  } finally {
    editorPermissionSavePending = false;
    updateComposerLockState();
  }
}

function updateComposerLockState() {
  const sendStarting = transitions.hasActiveSend();
  const projectSessionReady = state.activeTabOnTypst
    && typeof state.currentProjectId === 'string'
    && state.currentProjectId.length > 0
    && state.currentSession?.projectId === state.currentProjectId;
  const lock = !projectSessionReady || state.isStreaming || sendStarting;
  $('user-input').disabled = lock;
  $('send-btn').disabled = !state.isStreaming && (!projectSessionReady || sendStarting);
  $('add-context-btn').disabled = lock;
  document.querySelectorAll('.add-context-opt').forEach(b => { b.disabled = lock; });
  document.querySelectorAll('.empty-suggestion').forEach(button => { button.disabled = lock; });
  document.querySelectorAll('.edit-revert-button').forEach(button => {
    button.disabled = lock || button.dataset.busy === 'true';
  });
  document.querySelectorAll('[data-editor-approval-mode]').forEach(button => {
    button.disabled = state.isStreaming || sendStarting || editorPermissionSavePending;
  });
  const editorPermissionLocked = state.isStreaming || sendStarting || editorPermissionSavePending;
  $('editor-permission-btn').disabled = editorPermissionLocked;
  snapshotController.setLocked();
  if (lock && addContextMenuOpen) closeAddContextMenu();
  if (editorPermissionLocked && editorPermissionMenuOpen) closeEditorPermissionMenu();
}

function projectIdFromTab(tab) {
  const m = tab?.url?.match(/typst\.app\/project\/([^/?#]+)/);
  return m ? m[1] : null;
}

// =============================================================
// Tab gating + project sync
// =============================================================

async function syncTabFromBrowser() {
  const syncEpoch = transitions.nextTabSync();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!transitions.isTabSyncCurrent(syncEpoch)) return;
  const previousTabId = state.activeTabId;
  const onTypst = typeof tab?.url === 'string' && tab.url.startsWith('https://typst.app/');
  state.activeTabOnTypst = onTypst;
  state.activeTabId = Number.isInteger(tab?.id) ? tab.id : null;
  if (previousTabId !== state.activeTabId) {
    snapshotController.reset();
    resetRevertConfirmation();
  }
  state.activeWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : null;
  $('tab-gate-banner').classList.toggle('hidden', onTypst);
  updateComposerLockState();

  if (onTypst) {
    const pid = projectIdFromTab(tab);
    if (pid !== state.currentProjectId) {
      state.currentProjectId = pid;
      snapshotController.reset();
      resetRevertConfirmation();
      transitions.nextSessionSwitch();
      updateComposerLockState();
      attachmentController.clear();
      renderAllContextChips();
      if (pid) {
        await loadSessionsForProject(pid, syncEpoch);
        if (!transitions.isTabSyncCurrent(syncEpoch) || state.currentProjectId !== pid) return;
        setStatus('');
      } else {
        setStatus('Open a typst.app project to start', true);
      }
    } else if (!pid) {
      setStatus('Open a typst.app project to start', true);
    }
  } else {
    state.currentProjectId = null;
    resetRevertConfirmation();
    transitions.nextSessionSwitch();
    setStatus('');
  }
  updateComposerLockState();
  autoResize();
}

// =============================================================
// Sessions
// =============================================================

async function loadSessionsForProject(projectId, tabSyncEpoch = null) {
  const sessions = await sessionController.list(projectId);
  if (state.currentProjectId !== projectId || (tabSyncEpoch != null && !transitions.isTabSyncCurrent(tabSyncEpoch))) return false;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    const s = await sessionController.create(projectId);
    if (state.currentProjectId !== projectId || (tabSyncEpoch != null && !transitions.isTabSyncCurrent(tabSyncEpoch))) return false;
    return switchSession(s, { projectId, tabSyncEpoch });
  } else {
    renderSessionList(sessions);
    return switchSession(sessions[0], { projectId, tabSyncEpoch });
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
    switchSession(session).catch(error => setStatus(error.message || String(error), true));
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
      const sessions = await sessionController.list(state.currentProjectId);
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
  const updated = await sessionController.update(sessionId, { name, userRenamed: true });
  if (state.currentSession?.id === sessionId) {
    state.currentSession = { ...state.currentSession, ...(updated || {}), name };
    $('session-name').textContent = name;
    state.currentSession.userRenamed = true;
  }
  const sessions = await sessionController.list(state.currentProjectId);
  if (Array.isArray(sessions)) renderSessionList(sessions);
}

async function switchSession(session, options = {}) {
  const switchEpoch = transitions.nextSessionSwitch();
  const projectId = options.projectId ?? state.currentProjectId;
  const tabSyncEpoch = options.tabSyncEpoch ?? null;
  const isCurrent = () => transitions.isSessionSwitchCurrent(switchEpoch)
    && state.currentProjectId === projectId
    && (tabSyncEpoch == null || transitions.isTabSyncCurrent(tabSyncEpoch));
  if (state.activeRun && state.activeRun.sessionId !== session?.id) {
    await cancelActiveRunBeforeNavigation();
    if (!isCurrent()) return false;
  }
  try { await saveCurrentSession(); }
  catch (error) {
    setStatus(error.message || String(error), true);
    return false;
  }
  if (!isCurrent()) return false;
  const fullSession = Array.isArray(session?.messages) ? session : await sessionController.get(session?.id);
  if (!isCurrent()) return false;
  if (!fullSession || fullSession.projectId !== projectId) {
    setStatus('The selected chat is no longer available.', true);
    return false;
  }
  sessionController.activate(fullSession);
  snapshotController.reset();
  $('session-name').textContent = fullSession.name || 'New chat';
  renderMessages();
  const sessions = await sessionController.list(projectId);
  if (isCurrent() && Array.isArray(sessions)) renderSessionList(sessions);
  return true;
}

async function createNewSession() {
  if (!state.currentProjectId) {
    setStatus('Open a typst.app project first', true);
    return;
  }
  const s = await sessionController.create(state.currentProjectId);
  await switchSession(s);
  $('session-menu').classList.add('hidden');
}

async function deleteSession(sessionId) {
  await sessionController.remove(sessionId);
  const sessions = await sessionController.list(state.currentProjectId);
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
  const sessions = await sessionController.list(state.currentProjectId);
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
  await saveSessionSnapshot(state.currentSession.id, state.chatHistory);
}

async function saveSessionSnapshot(sessionId, messages) {
  if (!sessionId) return;
  await sessionController.saveSnapshot(sessionId, messages);
}

async function cancelActiveRunBeforeNavigation() {
  const run = state.activeRun;
  if (!run) return;
  setStatus('Stopping current run…');
  await bg({ type: PROTOCOL.AI_STREAM_CANCEL, runId: run.runId }).catch(() => {});
  await Promise.race([
    run.terminalPromise,
    new Promise(resolve => { setTimeout(resolve, 2500); })
  ]);
  if (state.activeRun === run) {
    flushPendingRender();
    if (state.isStreaming) finalizeStream(
      () => saveSessionSnapshot(run.sessionId, run.history).catch(error => setStatus(error.message, true)),
      { responseStatus: 'incomplete' }
    );
    runUiController.complete(run);
  }
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
    const fileSuffix = sel.activeFile?.relativePath ? ` · ${sel.activeFile.relativePath}` : '';
    const label = preview
      ? `Selection ${idx + 1}${fileSuffix}: ${preview}${(sel.text || '').length > 42 ? '…' : ''}`
      : `Selection ${idx + 1}${fileSuffix}`;
    appendContextChip(label, () => {
      attachmentController.removeSelection(sel.id);
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
      attachmentController.removePreview(pv.id);
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
  $('add-context-btn').setAttribute('aria-expanded', 'false');
}

function toggleAddContextMenu() {
  if (!state.activeTabOnTypst || state.isStreaming) return;
  if (!addContextMenuOpen) {
    closeEditorPermissionMenu();
    snapshotController.closeMenu();
  }
  addContextMenuOpen = !addContextMenuOpen;
  $('add-context-menu').classList.toggle('hidden', !addContextMenuOpen);
  $('add-context-btn').setAttribute('aria-expanded', String(addContextMenuOpen));
}

function closeEditorPermissionMenu() {
  editorPermissionMenuOpen = false;
  $('editor-permission-menu').classList.add('hidden');
  $('editor-permission-btn').setAttribute('aria-expanded', 'false');
}

function toggleEditorPermissionMenu() {
  if (state.isStreaming || transitions.hasActiveSend() || editorPermissionSavePending) return;
  if (!editorPermissionMenuOpen) {
    closeAddContextMenu();
    snapshotController.closeMenu();
  }
  editorPermissionMenuOpen = !editorPermissionMenuOpen;
  $('editor-permission-menu').classList.toggle('hidden', !editorPermissionMenuOpen);
  $('editor-permission-btn').setAttribute('aria-expanded', String(editorPermissionMenuOpen));
}

/** Read the active editor selection and append it to `state.attachments.selections`. */
async function attachCurrentEditorSelection(tabId = null) {
  const ctx = await bg({ type: PROTOCOL.GET_EDITOR_CONTEXT, ...(tabId == null ? {} : { tabId }) });
  if (ctx?.error) throw new Error(ctx.error);
  const t = (ctx.selectedText || '').trim();
  if (!t) {
    setStatus('No text selected', true, 2000);
    return;
  }
  attachmentController.addSelection(t, ctx.workspace?.active_editor_file);
  renderAllContextChips();
  setStatus('Selection added', false, 1500);
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
      const r = await bg(attachmentController.previewRequest('canvas'));
      if (r?.error) throw new Error(r.error);
      attachmentController.addPreview({ dataUrl: r.dataUrl, captureMode: 'canvas' });
      renderAllContextChips();
      setStatus('');
    } catch (e) { setStatus('Preview failed: ' + e.message, true); }
    return;
  }

  if (type === 'opened_image') {
    setStatus('Capturing opened image…');
    try {
      const r = await bg(attachmentController.previewRequest('asset'));
      if (r?.error) throw new Error(r.error);
      attachmentController.addPreview({ dataUrl: r.dataUrl, captureMode: 'asset' });
      renderAllContextChips();
      setStatus('Opened image attached', false, 1500);
    } catch (e) { setStatus('Image capture failed: ' + e.message, true); }
    return;
  }
}

function clearComposerAfterSend() {
  attachmentController.clear();
  renderAllContextChips();
}

async function persistSnapshotRestoreContext(value, restoreScope) {
  const update = normalizeEditorStateUpdate(value);
  if (!update) throw new Error('The snapshot restore context event was invalid.');
  if (state.activeTabId !== restoreScope?.tabId || state.currentProjectId !== restoreScope?.projectId || state.currentSession?.id !== restoreScope?.sessionId) {
    throw new Error('The active project or chat changed before the context event could be recorded.');
  }
  const target = state.chatHistory.at(-1);
  if (!target) return false;
  const updates = Array.isArray(target.editorStateUpdates) ? target.editorStateUpdates.slice() : [];
  if (!updates.some(item => item.snapshotId === update.snapshotId && item.restoredAt === update.restoredAt)) updates.push(update);
  target.editorStateUpdates = updates.slice(-16);
  await saveSessionSnapshot(state.currentSession?.id, state.chatHistory);
  return true;
}

async function refreshLiveAttachments(tabId = null) {
  if (!state.activeTabOnTypst) throw new Error('Open a typst.app tab first');
  setStatus('Refreshing attachments…');
  try {
    await attachmentController.refresh(tabId);
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
    const runId = state.activeRun?.runId;
    if (runId) await bg({ type: PROTOCOL.AI_STREAM_CANCEL, runId }).catch(() => {});
    return;
  }
  if (!state.activeTabOnTypst
      || !state.currentProjectId
      || state.currentSession?.projectId !== state.currentProjectId
      || state.activeRun
      || transitions.hasActiveSend()) return;

  const text = $('user-input').value.trim();
  if (!text) return;

  const modelConfig = getActiveModel();
  if (!modelConfig) { setStatus('Add a model in Settings first', true); return; }
  const originSession = state.currentSession;
  const originSessionId = originSession?.id || null;
  const originProjectId = state.currentProjectId;
  const originHistory = state.chatHistory;
  const sendToken = transitions.beginSend({ projectId: originProjectId, sessionId: originSessionId, history: originHistory });
  if (!sendToken) return;
  updateComposerLockState();

  let startedRun = null;
  try {
    const [originTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(originTab?.id) || projectIdFromTab(originTab) !== originProjectId || !originSessionId) {
      setStatus('The active Typst project or chat changed. Try sending again.', true);
      return;
    }

    const identityContext = await bg({
      type: PROTOCOL.GET_EDITOR_CONTEXT,
      tabId: originTab.id,
      projection: 'identity'
    });
    const activeEditorFile = activeEditorFileFromContext(identityContext);
    if (!activeEditorFile) {
      setStatus('The open Typst file could not be identified. Nothing was sent; reload the Typst tab and try again.', true);
      return;
    }

    try { await refreshLiveAttachments(originTab.id); } catch { return; }
    const attachments = attachmentController.composePayload();
    const sentAttachments = await attachmentController.buildHistorySnapshot(attachments);
    const [confirmedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const identityStillCurrent = transitions.isSendCurrent(sendToken, {
      projectId: state.currentProjectId,
      sessionId: state.currentSession?.id || null,
      history: state.chatHistory
    });
    if (!identityStillCurrent || confirmedTab?.id !== originTab.id || projectIdFromTab(confirmedTab) !== originProjectId || state.activeRun) {
      setStatus('The active Typst project or chat changed while preparing the message. Nothing was sent.', true);
      return;
    }

    const userEntry = { role: 'user', content: text, activeEditorFile };
    if (sentAttachments.selections.length || sentAttachments.previews.length) userEntry.sentAttachments = sentAttachments;
    const runId = createRunId();
    startedRun = runUiController.begin({
      runId,
      tabId: originTab.id,
      projectId: originProjectId,
      sessionId: originSessionId,
      history: originHistory
    });
    state.isStreaming = true;

    setStatus('');
    originHistory.push(userEntry);
    renderUserMessage(userEntry);
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
      segments: [],
      renderFrame: null,
      dirtyContent: false,
      dirtyReasoning: false,
      followBeforeRender: null
    };
    updateComposerLockState();
    setSendButtonStop(true);

    await saveSessionSnapshot(originSessionId, originHistory);

    maybeAutoNameSession({ session: originSession, history: originHistory }).catch(error => {
      setStatus(`Chat auto-name failed: ${error?.message || String(error)}`, true);
    });

    bg({
      type: PROTOCOL.AI_STREAM_START,
      runId,
      tabId: originTab.id,
      projectId: originProjectId,
      sessionId: originSessionId,
      messages: originHistory,
      settings: state.settings,
      modelConfig,
      attachments,
      activeEditorFile
    }).then(r => {
      if (r?.ok === false && state.activeRun?.runId === runId && state.isStreaming) {
        failStream(r.error || 'Run failed', setStatus);
        runUiController.complete(state.activeRun);
      }
    }).catch(e => {
      if (state.activeRun?.runId === runId && state.isStreaming) {
        failStream(e.message, setStatus);
        runUiController.complete(state.activeRun);
      }
    });

  } catch (error) {
    if (startedRun && state.activeRun === startedRun) {
      if (state.isStreaming) failStream(error.message || String(error), setStatus);
      runUiController.complete(startedRun);
    } else {
      setStatus(error.message || String(error), true);
    }
  } finally {
    transitions.endSend(sendToken);
    updateComposerLockState();
  }
}

function onStreamFinalize(run = state.activeRun) {
  if (run) saveSessionSnapshot(run.sessionId, run.history).catch(error => setStatus(error.message, true));
  else saveCurrentSession().catch(error => setStatus(error.message, true));
  setStatus('');
  $('user-input').focus();
  updateComposerLockState();
}

async function finishReconnectedRun(run, terminalMessage) {
  runUiController.complete(run);
  state.isStreaming = false;
  setSendButtonStop(false);
  try {
    const session = await sessionController.get(run.sessionId);
    if (session && state.currentSession?.id === run.sessionId) {
      sessionController.activate(session);
      renderMessages();
    }
    const snapshotWarning = terminalMessage.type === PROTOCOL.AI_STREAM_DONE ? terminalMessage.payload?.snapshotWarning : '';
    setStatus(snapshotWarning || (terminalMessage.type === PROTOCOL.AI_STREAM_CANCELLED ? 'Stopped' : terminalMessage.type === PROTOCOL.AI_STREAM_ERROR ? (terminalMessage.payload.message || 'Run failed') : 'Run completed'), terminalMessage.type === PROTOCOL.AI_STREAM_ERROR || !!snapshotWarning, snapshotWarning ? 0 : 2000);
    await snapshotController.refreshIfOpen();
  } catch (error) {
    setStatus(`Could not reload the completed run: ${error.message || String(error)}`, true);
  } finally {
    updateComposerLockState();
  }
}

async function recoverActiveRunState() {
  const session = state.currentSession;
  if (!state.currentProjectId || !session?.id || state.activeRun) return;
  const active = await bg({
    type: PROTOCOL.AI_RUN_STATUS,
    projectId: state.currentProjectId,
    sessionId: session.id
  });
  const latest = Array.isArray(active) ? active.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] : null;
  if (!latest) {
    const refreshed = await sessionController.get(session.id);
    if (refreshed && state.currentSession?.id === session.id) {
      sessionController.activate(refreshed);
      renderMessages();
    }
    return;
  }
  const run = runUiController.begin({ ...latest, history: state.chatHistory, reconnected: true });
  state.isStreaming = true;
  setSendButtonStop(true);
  setStatus('The active run is continuing in the background…');
  updateComposerLockState();
  const confirmed = await bg({
    type: PROTOCOL.AI_RUN_STATUS,
    projectId: state.currentProjectId,
    sessionId: session.id
  });
  if (state.activeRun === run && (!Array.isArray(confirmed) || !confirmed.some(item => item.runId === run.runId))) {
    await finishReconnectedRun(run, { type: PROTOCOL.AI_STREAM_DONE, payload: {} });
  }
}

async function maybeAutoNameSession({ session = state.currentSession, history = state.chatHistory } = {}) {
  if (!session) return;
  const generation = (autoNameGenerationBySession.get(session.id) || 0) + 1;
  autoNameGenerationBySession.set(session.id, generation);
  if (session.userRenamed) return;

  const modelId = state.settings.autoNameModelId;
  if (!modelId) return;
  const modelConfig = state.settings.models.find(m => m.id === modelId);
  if (!modelConfig) return;

  // Snapshot the conversation at send time and discard an older response if a
  // newer user message starts another naming request for this session.
  const slim = history
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
    .filter(m => m.content);
  if (!slim.length) return;

  const r = await bg({ type: PROTOCOL.GENERATE_SESSION_TITLE, modelConfig, messages: slim });
  if (!r?.ok || !r.title) {
    throw new Error(r?.error?.message || 'The naming model did not return a title.');
  }

  // A newer send or manual rename always wins. The guarded storage update can
  // still name the originating session if the user navigated elsewhere.
  if (autoNameGenerationBySession.get(session.id) !== generation) return;
  if (state.currentSession?.id === session.id && state.currentSession.userRenamed) return;

  const updated = await sessionController.updateAutoName(session.id, r.title);
  if (!updated || updated.userRenamed || updated.name !== r.title) return;
  if (autoNameGenerationBySession.get(session.id) !== generation) return;
  if (state.currentSession?.id !== session.id || state.currentSession.userRenamed) return;
  state.currentSession = { ...state.currentSession, name: updated.name };
  $('session-name').textContent = updated.name;
  const sessions = await sessionController.list(state.currentProjectId);
  if (Array.isArray(sessions)) renderSessionList(sessions);
}

// =============================================================
// Theme + load
// =============================================================

async function loadTheme() {
  try {
    const t = await bg({ type: PROTOCOL.LOAD_THEME });
    applyTheme(t || 'dark');
  } catch {
    applyTheme('dark');
  }
}

async function loadAllRegistries() {
  const [settings, customTools, mcpServers] = await Promise.all([
    bg({ type: PROTOCOL.LOAD_SETTINGS }),
    bg({ type: PROTOCOL.LOAD_CUSTOM_TOOLS }),
    bg({ type: PROTOCOL.LOAD_MCP_SERVERS })
  ]);

  if (settings && !settings.error) {
    state.settings = {
      systemPrompt: settings.systemPrompt || '',
      models: Array.isArray(settings.models) ? settings.models : [],
      activeModelId: settings.activeModelId || null,
      maxHistoryMessages: settings.maxHistoryMessages || 40,
      autoNameModelId: settings.autoNameModelId ?? null,
      editorApprovalMode: normalizeEditorApprovalMode(settings.editorApprovalMode),
      sendMessageShortcut: normalizeSendMessageShortcut(settings.sendMessageShortcut)
    };
  }
  state.customTools = Array.isArray(customTools) ? customTools : [];
  state.mcpServers = Array.isArray(mcpServers) ? mcpServers : [];

  renderGeneralSettings();
  renderSendMessageShortcut();
  renderModelRegistry();
  renderModelSelector();
  renderCustomToolRegistry();
  renderMcpRegistry();
  renderEditorApprovalMode();
}

// =============================================================
// Quick attach (from page float buttons)
// =============================================================

async function quickAttachSelection(source) {
  if (!state.activeTabOnTypst || !isQuickAttachForPanel(state, source)) return;
  try {
    await attachCurrentEditorSelection(source.tabId);
  } catch (e) {
    setStatus('Quick attach failed: ' + e.message, true);
  }
}

async function quickAttachImagePreview(source) {
  if (!state.activeTabOnTypst || !isQuickAttachForPanel(state, source)) return;
  if (quickImageAttachBusy) return;
  quickImageAttachBusy = true;
  try {
    setStatus('Capturing preview image…');
    const r = await bg({ type: PROTOCOL.GET_PREVIEW, tabId: source.tabId });
    if (r?.error) throw new Error(r.error);
    if (!r?.dataUrl) throw new Error('No image data');
    attachmentController.addPreview({ dataUrl: r.dataUrl, captureMode: 'auto' });
    renderAllContextChips();
    setStatus('Image added', false, 1500);
  } catch (e) {
    setStatus('Image attach failed: ' + e.message, true, 3000);
  } finally {
    quickImageAttachBusy = false;
  }
}

function deliverQuickAttach(type, source) {
  quickAttachDeliveryQueue = quickAttachDeliveryQueue.then(() => type === PROTOCOL.QUICK_ATTACH_SELECTION
    ? quickAttachSelection(source)
    : quickAttachImagePreview(source)).catch(error => setStatus(error.message || String(error), true));
}

function enqueueQuickAttach(type, source) {
  const eventId = typeof source?.eventId === 'string' ? source.eventId : null;
  if (eventId && seenQuickAttachIds.has(eventId)) return;
  if (eventId) {
    seenQuickAttachIds.add(eventId);
    while (seenQuickAttachIds.size > 128) seenQuickAttachIds.delete(seenQuickAttachIds.values().next().value);
  }
  if (!panelReadyForQuickAttach) {
    queuedQuickAttaches.push({ type, source });
    return;
  }
  deliverQuickAttach(type, source);
}

async function drainQuickAttachments() {
  panelReadyForQuickAttach = true;
  const local = queuedQuickAttaches.splice(0);
  let remote = [];
  if (Number.isInteger(state.activeWindowId)) {
    remote = await bg({ type: PROTOCOL.QUICK_ATTACH_DRAIN, windowId: state.activeWindowId });
  }
  for (const item of local) {
    if ([PROTOCOL.QUICK_ATTACH_SELECTION, PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW].includes(item.type)) deliverQuickAttach(item.type, item.source);
  }
  for (const item of (Array.isArray(remote) ? remote.map(record => ({ type: record.type, source: record.payload })) : [])) {
    if ([PROTOCOL.QUICK_ATTACH_SELECTION, PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW].includes(item.type)) enqueueQuickAttach(item.type, item.source);
  }
}

// =============================================================
// Wiring
// =============================================================

function wireRuntimeMessages() {
  chrome.runtime.onMessage.addListener((msg) => {
    const checked = validateEnvelope(msg);
    if (!checked.ok) return;
    const payload = msg.payload;
    if (!runUiController.accepts(msg)) return;
    switch (msg.type) {
      case PROTOCOL.AI_STREAM_BATCH:
        for (const item of Array.isArray(payload.items) ? payload.items : []) {
          if (item?.channel === 'content') appendChunk(item.text);
          else if (item?.channel === 'reasoning') appendReasoning(item.text);
        }
        break;
      case PROTOCOL.AI_STREAM_DONE:
      case PROTOCOL.AI_STREAM_CANCELLED: {
        const run = state.activeRun;
        if (run?.reconnected) {
          finishReconnectedRun(run, msg).catch(error => setStatus(error.message || String(error), true));
          break;
        }
        if (state.isStreaming) finalizeStream(
          () => onStreamFinalize(run),
          { responseStatus: msg.type === PROTOCOL.AI_STREAM_DONE ? 'complete' : 'incomplete' }
        );
        runUiController.complete(run);
        updateComposerLockState();
        snapshotController.refreshIfOpen().catch(() => {});
        if (msg.type === PROTOCOL.AI_STREAM_DONE && payload.snapshotWarning) setStatus(payload.snapshotWarning, true);
        if (msg.type === PROTOCOL.AI_STREAM_CANCELLED) setStatus('Stopped');
        break;
      }
      case PROTOCOL.AI_STREAM_ERROR: {
        const run = state.activeRun;
        if (run?.reconnected) {
          finishReconnectedRun(run, msg).catch(error => setStatus(error.message || String(error), true));
          break;
        }
        const hasPartial = !!(state.stream.allText || state.stream.allReasoning || state.stream.toolCalls.length);
        if (hasPartial) finalizeStream(() => onStreamFinalize(run), { responseStatus: 'incomplete' });
        else failStream(payload.message, setStatus);
        runUiController.complete(run);
        updateComposerLockState();
        setStatus(payload.message || 'Run failed', true);
        break;
      }
      case PROTOCOL.AI_TOOL_CALLS: handleToolCalls(payload.calls || []); break;
      case PROTOCOL.AI_TOOL_RESULT: handleToolResult(payload.callId, payload.name, payload.result); break;
      case PROTOCOL.AI_TOOL_PREFLIGHT_WAITING: markPreflightWaiting(payload); break;
      case PROTOCOL.AI_TOOL_PREFLIGHT_READY: markPreflightReady(payload.callId); break;
      case PROTOCOL.AI_TOOL_APPROVAL_REQUIRED: markApprovalRequired({ ...payload, runId: msg.runId }); break;
      case PROTOCOL.ACTIVE_TAB_CHANGED: syncTabFromBrowser().catch(error => setStatus(error.message || String(error), true)); break;
      case PROTOCOL.QUICK_ATTACH_SELECTION: enqueueQuickAttach(msg.type, payload); break;
      case PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW: enqueueQuickAttach(msg.type, payload); break;
    }
  });
}

function wireUi() {
  configureAboutUi();

  // Header dropdowns
  $('session-current').addEventListener('click', () => $('session-menu').classList.toggle('hidden'));
  $('session-new').addEventListener('click', () => createNewSession().catch(error => setStatus(error.message || String(error), true)));
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
    const editorPermissionWrap = $('editor-permission-wrap');
    if (editorPermissionWrap && !editorPermissionWrap.contains(e.target)) closeEditorPermissionMenu();
  });

  // Settings panel
  $('settings-toggle').addEventListener('click', () => {
    setSettingsOpen($('settings-panel').classList.contains('collapsed'));
  });
  $('settings-close').addEventListener('click', () => setSettingsOpen(false));
  $('about-icon-button').addEventListener('click', event => openAboutDialog(event.currentTarget));
  $('about-settings-button').addEventListener('click', event => openAboutDialog(event.currentTarget));
  $('about-dialog-close').addEventListener('click', () => closeAboutDialog());
  $('about-dialog-layer').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeAboutDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('about-dialog-layer').classList.contains('hidden')) {
      event.preventDefault();
      closeAboutDialog();
    } else if (editorPermissionMenuOpen) {
      event.preventDefault();
      closeEditorPermissionMenu();
      $('editor-permission-btn').focus();
    } else if (addContextMenuOpen) {
      event.preventDefault();
      closeAddContextMenu();
      $('add-context-btn').focus();
    } else if (!$('settings-panel').classList.contains('collapsed')) {
      setSettingsOpen(false);
      $('settings-toggle').focus();
    }
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
  $('editor-permission-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleEditorPermissionMenu();
  });
  document.querySelectorAll('[data-editor-approval-mode]').forEach(button => {
    button.addEventListener('click', () => {
      closeEditorPermissionMenu();
      setEditorApprovalMode(button.dataset.editorApprovalMode);
    });
  });
  snapshotController.init();
  $('send-btn').addEventListener('click', (e) => { e.preventDefault(); handleSend().catch(error => setStatus(error.message || String(error), true)); });
  $('user-input').addEventListener('input', autoResize);
  $('user-input').addEventListener('keydown', (e) => {
    if (shouldSendMessageForKey(e, state.settings.sendMessageShortcut)) {
      e.preventDefault();
      handleSend().catch(error => setStatus(error.message || String(error), true));
    }
  });
  $('jump-latest').addEventListener('click', scrollToBottom);
}

// =============================================================
// Init
// =============================================================

async function init() {
  setupMarkdown();
  setSendButtonStop(false);

  initSettingsTabs();
  initThemeSwitch();
  initGeneralSettings(renderSendMessageShortcut);
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

  wireRuntimeMessages();

  await loadTheme();
  await loadAllRegistries();

  if (!state.settings.models || state.settings.models.length === 0) {
    setSettingsOpen(true);
    const tabs = document.querySelectorAll('.settings-tab');
    const panes = document.querySelectorAll('.settings-tab-pane');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'models'));
    panes.forEach(p => p.classList.toggle('active', p.dataset.pane === 'models'));
  }

  wireUi();

  await syncTabFromBrowser();
  renderMessages();
  await drainQuickAttachments();
  await recoverActiveRunState();
}

document.addEventListener('DOMContentLoaded', init);
