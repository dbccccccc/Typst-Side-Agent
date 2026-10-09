/**
 * Side panel composition root. It creates the controllers, keeps the active
 * tab/project/chat in sync, and wires DOM events and worker messages to them.
 * The send flow lives in send-controller.js, the transcript in chat.js, and
 * settings in settings-panel.js.
 */
import { state, bg, uid, getActiveModel } from './state.js';
import { PROTOCOL, createRunId, validateEnvelope } from '../shared/protocol.js';
import { normalizeEditorApprovalMode, normalizeSendMessageShortcut } from '../shared/constants.js';
import { isQuickAttachForPanel } from '../shared/quick-attach.js';
import { normalizeEditorStateUpdate } from '../shared/document-snapshot.js';
import { createSessionController } from './session-controller.js';
import { createAttachmentController } from './attachment-controller.js';
import { createRunUiController } from './run-ui-controller.js';
import { createTransitionCoordinator } from './transition-coordinator.js';
import { createSendController } from './send-controller.js';
import { createQuickAttachController } from './quick-attach-controller.js';
import { createSessionMenu } from './session-menu.js';
import { createAboutDialog } from './about-dialog.js';
import { setStatus } from './status-controller.js';
import { sendMessageShortcutLabel, shouldSendMessageForKey } from './composer-shortcut.js';
import { renderEditDiffPreview } from './edit-diff.js';
import { createSnapshotController } from './snapshot-controller.js';
import {
  initSettingsTabs, initThemeSwitch, applyTheme,
  initGeneralSettings, renderGeneralSettings,
  initModels, renderModelRegistry, renderModelSelector,
  initCustomTools, renderCustomToolRegistry,
  initMcpServers, renderMcpRegistry,
  initSessionsManager, openSessionsManagerPane
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
const RUN_CANCEL_GRACE_MS = 2500;

let addContextMenuOpen = false;
let editorPermissionMenuOpen = false;
let quickImageAttachBusy = false;
let editorPermissionSavePending = false;
const autoNameGenerationBySession = new Map();

// =============================================================
// Controllers
// =============================================================

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
  isLocked: () => !state.activeTabOnTypst || state.isStreaming || transitions.hasActiveSend()
    || !state.currentProjectId || state.currentSession?.projectId !== state.currentProjectId,
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
const sessionMenu = createSessionMenu({
  state,
  listSessions: () => sessionController.list(state.currentProjectId),
  renameSession,
  switchSession: session => switchSession(session),
  deleteSession,
  setStatus
});
const aboutDialog = createAboutDialog({
  storeUrl: CHROME_WEB_STORE_URL,
  onBeforeOpen: () => {
    closeAddContextMenu();
    closeEditorPermissionMenu();
    $('session-menu').classList.add('hidden');
    $('model-menu').classList.add('hidden');
  }
});
const quickAttach = createQuickAttachController({
  state,
  request: bg,
  deliver: (type, source) => (type === PROTOCOL.QUICK_ATTACH_SELECTION
    ? quickAttachSelection(source)
    : quickAttachImagePreview(source)),
  setStatus
});
const sendController = createSendController({
  state,
  request: bg,
  transitions,
  runUiController,
  attachmentController,
  queryActiveTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
  projectIdFromTab,
  getActiveModel,
  createRunId,
  saveSessionSnapshot,
  view: {
    setStatus,
    readComposerText: () => $('user-input').value.trim(),
    clearComposer: () => {
      clearComposerAfterSend();
      $('user-input').value = '';
      autoResize();
    },
    renderUserMessage,
    scrollToBottom,
    createStreamingMessage,
    updateComposerLockState,
    setSendButtonStop,
    finalizeStream,
    failStream,
    onStreamFinalize,
    refreshLiveAttachments,
    maybeAutoNameSession
  }
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
    trigger.setAttribute('aria-label', mode === 'auto' ? 'Document edits: auto approve' : 'Document edits: ask before applying');
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

async function setEditorApprovalMode(value) {
  const next = normalizeEditorApprovalMode(value);
  const previous = normalizeEditorApprovalMode(state.settings.editorApprovalMode);
  if (next === previous || editorPermissionSavePending || state.isStreaming) return;

  editorPermissionSavePending = true;
  state.settings.editorApprovalMode = next;
  renderEditorApprovalMode();
  updateComposerLockState();
  try {
    const saved = await bg({ type: PROTOCOL.SAVE_SETTINGS, settings: state.settings, fields: ['editorApprovalMode'] });
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
  const editorPermissionLocked = state.isStreaming || sendStarting || editorPermissionSavePending;
  document.querySelectorAll('[data-editor-approval-mode]').forEach(button => {
    button.disabled = editorPermissionLocked;
  });
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
  const stale = () => state.currentProjectId !== projectId || (tabSyncEpoch != null && !transitions.isTabSyncCurrent(tabSyncEpoch));
  const sessions = await sessionController.list(projectId);
  if (stale()) return false;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    const created = await sessionController.create(projectId);
    if (stale()) return false;
    return switchSession(created, { projectId, tabSyncEpoch });
  }
  sessionMenu.render(sessions);
  return switchSession(sessions[0], { projectId, tabSyncEpoch });
}

async function renameSession(sessionId, name) {
  const updated = await sessionController.update(sessionId, { name, userRenamed: true });
  if (state.currentSession?.id === sessionId) {
    state.currentSession = { ...state.currentSession, ...(updated || {}), name, userRenamed: true };
    $('session-name').textContent = name;
  }
  await sessionMenu.refresh();
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
  if (isCurrent() && Array.isArray(sessions)) sessionMenu.render(sessions);
  return true;
}

async function createNewSession() {
  if (!state.currentProjectId) {
    setStatus('Open a typst.app project first', true);
    return;
  }
  const created = await sessionController.create(state.currentProjectId);
  await switchSession(created);
  $('session-menu').classList.add('hidden');
}

async function deleteSession(sessionId) {
  await sessionController.remove(sessionId);
  const sessions = await sessionController.list(state.currentProjectId);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    await createNewSession();
  } else if (state.currentSession?.id === sessionId) {
    await switchSession(sessions[0]);
  } else {
    sessionMenu.render(sessions);
  }
}

/**
 * Reconcile the session dropdown and the active chat after the manage pane
 * mutates storage (rename / delete / bulk delete / import).
 */
async function reconcileAfterSessionMutation() {
  if (!state.currentProjectId) return;
  const sessions = await sessionController.list(state.currentProjectId);
  const list = Array.isArray(sessions) ? sessions : [];
  sessionMenu.render(list);
  if (!state.currentSession) return;
  const stillThere = list.find(s => s.id === state.currentSession.id);
  if (!stillThere) {
    if (list.length > 0) await switchSession(list[0]);
    else await createNewSession();
  } else if (stillThere.name !== state.currentSession.name) {
    state.currentSession = { ...state.currentSession, name: stillThere.name };
    $('session-name').textContent = stillThere.name;
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
  transitions.cancelRun(run.runId);
  await bg({ type: PROTOCOL.AI_STREAM_CANCEL, runId: run.runId }).catch(() => {});
  await Promise.race([
    run.terminalPromise,
    new Promise(resolve => { setTimeout(resolve, RUN_CANCEL_GRACE_MS); })
  ]);
  if (state.activeRun === run) {
    flushPendingRender();
    if (state.isStreaming) {
      finalizeStream(
        () => saveSessionSnapshot(run.sessionId, run.history).catch(error => setStatus(error.message, true)),
        { responseStatus: 'incomplete' }
      );
    }
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
  chip.append(lab, del);
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
  state.attachments.previews.forEach(pv => {
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
    wrap.append(img, del);
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

/** Read the active editor selection and append it to the pending attachments. */
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

async function capturePreviewAttachment(captureMode, { busy, success }) {
  setStatus(busy);
  const result = await bg(attachmentController.previewRequest(captureMode));
  if (result?.error) throw new Error(result.error);
  attachmentController.addPreview({ dataUrl: result.dataUrl, captureMode });
  renderAllContextChips();
  if (success) setStatus(success, false, 1500);
  else setStatus('');
}

async function handleAddContextAction(type) {
  closeAddContextMenu();
  if (!state.activeTabOnTypst || state.isStreaming) return;
  if (type === 'selection') {
    setStatus('Reading selection…');
    try { await attachCurrentEditorSelection(); }
    catch (e) { setStatus('Selection failed: ' + e.message, true); }
  } else if (type === 'preview') {
    try { await capturePreviewAttachment('canvas', { busy: 'Capturing preview…' }); }
    catch (e) { setStatus('Preview failed: ' + e.message, true); }
  } else if (type === 'opened_image') {
    try { await capturePreviewAttachment('asset', { busy: 'Capturing opened image…', success: 'Opened image attached' }); }
    catch (e) { setStatus('Image capture failed: ' + e.message, true); }
  }
}

function clearComposerAfterSend() {
  attachmentController.clear();
  renderAllContextChips();
}

async function persistSnapshotRestoreContext(value, restoreScope) {
  const update = normalizeEditorStateUpdate(value);
  if (!update) throw new Error('The snapshot restore context event was invalid.');
  const scopeCurrent = state.activeTabId === restoreScope?.tabId
    && state.currentProjectId === restoreScope?.projectId
    && state.currentSession?.id === restoreScope?.sessionId;
  if (!scopeCurrent) throw new Error('The active project or chat changed before the context event could be recorded.');
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
// Run lifecycle glue
// =============================================================

function onStreamFinalize(run = state.activeRun) {
  if (run) saveSessionSnapshot(run.sessionId, run.history).catch(error => setStatus(error.message, true));
  else saveCurrentSession().catch(error => setStatus(error.message, true));
  setStatus('');
  $('user-input').focus();
  updateComposerLockState();
}

function terminalStatus(terminalMessage, snapshotWarning) {
  if (snapshotWarning) return snapshotWarning;
  if (terminalMessage.type === PROTOCOL.AI_STREAM_CANCELLED) return 'Stopped';
  if (terminalMessage.type === PROTOCOL.AI_STREAM_ERROR) return terminalMessage.payload.message || 'Run failed';
  return 'Run completed';
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
    const isError = terminalMessage.type === PROTOCOL.AI_STREAM_ERROR || !!snapshotWarning;
    setStatus(terminalStatus(terminalMessage, snapshotWarning), isError, snapshotWarning ? 0 : 2000);
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
  const statusRequest = { type: PROTOCOL.AI_RUN_STATUS, projectId: state.currentProjectId, sessionId: session.id };
  const active = await bg(statusRequest);
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
  const confirmed = await bg(statusRequest);
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
  if (!r?.ok || !r.title) throw new Error(r?.error?.message || 'The naming model did not return a title.');

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
  await sessionMenu.refresh();
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

// =============================================================
// Wiring
// =============================================================

function handleTerminalEvent(msg) {
  const run = state.activeRun;
  if (run?.reconnected) {
    finishReconnectedRun(run, msg).catch(error => setStatus(error.message || String(error), true));
    return;
  }
  if (msg.type === PROTOCOL.AI_STREAM_ERROR) {
    const hasPartial = !!(state.stream.allText || state.stream.allReasoning || state.stream.toolCalls.length);
    if (hasPartial) finalizeStream(() => onStreamFinalize(run), { responseStatus: 'incomplete' });
    else failStream(msg.payload.message, setStatus);
    runUiController.complete(run);
    updateComposerLockState();
    setStatus(msg.payload.message || 'Run failed', true);
    return;
  }
  if (state.isStreaming) {
    finalizeStream(() => onStreamFinalize(run), { responseStatus: msg.type === PROTOCOL.AI_STREAM_DONE ? 'complete' : 'incomplete' });
  }
  runUiController.complete(run);
  updateComposerLockState();
  snapshotController.refreshIfOpen().catch(() => {});
  if (msg.type === PROTOCOL.AI_STREAM_DONE && msg.payload.snapshotWarning) setStatus(msg.payload.snapshotWarning, true);
  if (msg.type === PROTOCOL.AI_STREAM_CANCELLED) setStatus('Stopped');
}

function wireRuntimeMessages() {
  chrome.runtime.onMessage.addListener(msg => {
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
      case PROTOCOL.AI_STREAM_CANCELLED:
      case PROTOCOL.AI_STREAM_ERROR:
        handleTerminalEvent(msg);
        break;
      case PROTOCOL.AI_TOOL_CALLS: handleToolCalls(payload.calls || []); break;
      case PROTOCOL.AI_TOOL_RESULT: handleToolResult(payload.callId, payload.name, payload.result); break;
      case PROTOCOL.AI_TOOL_PREFLIGHT_WAITING: markPreflightWaiting(payload); break;
      case PROTOCOL.AI_TOOL_PREFLIGHT_READY: markPreflightReady(payload.callId); break;
      case PROTOCOL.AI_TOOL_APPROVAL_REQUIRED: markApprovalRequired({ ...payload, runId: msg.runId }); break;
      case PROTOCOL.ACTIVE_TAB_CHANGED: syncTabFromBrowser().catch(error => setStatus(error.message || String(error), true)); break;
      case PROTOCOL.QUICK_ATTACH_SELECTION:
      case PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW:
        quickAttach.enqueue(msg.type, payload);
        break;
      default:
        break;
    }
  });
}

function handleEscape(event) {
  if (aboutDialog.isOpen()) {
    event.preventDefault();
    aboutDialog.close();
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
}

function sendFromComposer() {
  sendController.send().catch(error => setStatus(error.message || String(error), true));
}

function wireUi() {
  aboutDialog.configure(chrome.runtime.getManifest().version);
  aboutDialog.wire();

  // Header dropdowns
  $('session-current').addEventListener('click', () => $('session-menu').classList.toggle('hidden'));
  $('session-new').addEventListener('click', () => createNewSession().catch(error => setStatus(error.message || String(error), true)));
  $('session-manage').addEventListener('click', () => {
    $('session-menu').classList.add('hidden');
    openSessionsManagerPane().catch(() => {});
  });
  $('model-current').addEventListener('click', () => $('model-menu').classList.toggle('hidden'));

  // Outside click closers
  document.addEventListener('click', event => {
    if (!$('session-dropdown').contains(event.target)) $('session-menu').classList.add('hidden');
    if (!$('model-selector').contains(event.target)) $('model-menu').classList.add('hidden');
    const wrap = $('add-context-wrap');
    if (wrap && !wrap.contains(event.target)) closeAddContextMenu();
    const editorPermissionWrap = $('editor-permission-wrap');
    if (editorPermissionWrap && !editorPermissionWrap.contains(event.target)) closeEditorPermissionMenu();
  });

  // Settings panel
  $('settings-toggle').addEventListener('click', () => setSettingsOpen($('settings-panel').classList.contains('collapsed')));
  $('settings-close').addEventListener('click', () => setSettingsOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') handleEscape(event);
  });

  // Add context menu
  $('add-context-btn').addEventListener('click', event => {
    event.stopPropagation();
    toggleAddContextMenu();
  });
  document.querySelectorAll('.add-context-opt[data-add]').forEach(btn => {
    btn.addEventListener('click', () => handleAddContextAction(btn.dataset.add));
  });

  // Composer
  $('editor-permission-btn').addEventListener('click', event => {
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
  $('send-btn').addEventListener('click', event => {
    event.preventDefault();
    sendFromComposer();
  });
  $('user-input').addEventListener('input', autoResize);
  $('user-input').addEventListener('keydown', event => {
    if (shouldSendMessageForKey(event, state.settings.sendMessageShortcut)) {
      event.preventDefault();
      sendFromComposer();
    }
  });
  $('jump-latest').addEventListener('click', scrollToBottom);
}

// =============================================================
// Init
// =============================================================

function openModelsTabWhenUnconfigured() {
  if (state.settings.models && state.settings.models.length > 0) return;
  setSettingsOpen(true);
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'models'));
  document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'models'));
}

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
    onSwitchToSession: async session => {
      if (!session?.projectId || session.projectId !== state.currentProjectId) return;
      await switchSession(session);
      $('session-menu').classList.add('hidden');
    }
  });

  wireRuntimeMessages();

  await loadTheme();
  await loadAllRegistries();
  openModelsTabWhenUnconfigured();
  wireUi();

  await syncTabFromBrowser();
  renderMessages();
  await quickAttach.drain();
  await recoverActiveRunState();
}

document.addEventListener('DOMContentLoaded', init);
