/**
 * The Send flow as explicit steps. Every await re-checks that the captured
 * project, chat, tab, and history are still current, so a stale send can never
 * append a turn to another chat or dispatch a run after Stop.
 */
import { PROTOCOL } from '../shared/protocol.js';
import { activeEditorFileFromContext } from '../shared/active-file.js';
import { resetStream as resetStreamState } from './state.js';

const STATUS = Object.freeze({
  NO_MODEL: 'Add a model in Settings first',
  CONTEXT_CHANGED: 'The active Typst project or chat changed. Try sending again.',
  FILE_UNKNOWN: 'The open Typst file could not be identified. Nothing was sent; reload the Typst tab and try again.',
  CHANGED_WHILE_PREPARING: 'The active Typst project or chat changed while preparing the message. Nothing was sent.',
  CHANGED_WHILE_RESERVING: 'The active Typst project or chat changed while reserving the run. Nothing was sent.',
  STOPPING: 'Stopping…',
  STOPPED: 'Stopped'
});

export function createSendController({
  state,
  request,
  transitions,
  runUiController,
  attachmentController,
  queryActiveTab,
  projectIdFromTab,
  getActiveModel,
  createRunId,
  saveSessionSnapshot,
  view,
  resetStream = resetStreamState
}) {
  const required = {
    state, request, transitions, runUiController, attachmentController, queryActiveTab,
    projectIdFromTab, getActiveModel, createRunId, saveSessionSnapshot, view
  };
  for (const [name, value] of Object.entries(required)) {
    if (value == null) throw new TypeError(`Send controller requires ${name}.`);
  }

  function currentIdentity() {
    return { projectId: state.currentProjectId, sessionId: state.currentSession?.id || null, history: state.chatHistory };
  }

  async function stopActiveRun() {
    view.setStatus(STATUS.STOPPING);
    const runId = state.activeRun?.runId;
    if (!runId) return;
    transitions.cancelRun(runId);
    await request({ type: PROTOCOL.AI_STREAM_CANCEL, runId }).catch(() => {});
  }

  function canStart() {
    return state.activeTabOnTypst
      && !!state.currentProjectId
      && state.currentSession?.projectId === state.currentProjectId
      && !state.activeRun
      && !transitions.hasActiveSend();
  }

  /** Capture the originating tab and confirm it still shows the captured project. */
  async function captureOriginTab(origin) {
    const tab = await queryActiveTab();
    if (!Number.isInteger(tab?.id) || projectIdFromTab(tab) !== origin.projectId || !origin.sessionId) {
      view.setStatus(STATUS.CONTEXT_CHANGED, true);
      return null;
    }
    return tab;
  }

  /** Identity only: the breadcrumb file, never document text. */
  async function captureFileIdentity(tab) {
    const context = await request({ type: PROTOCOL.GET_EDITOR_CONTEXT, tabId: tab.id, projection: 'identity' });
    const activeEditorFile = activeEditorFileFromContext(context);
    if (!activeEditorFile) view.setStatus(STATUS.FILE_UNKNOWN, true);
    return activeEditorFile;
  }

  async function prepareAttachments(tab) {
    try { await view.refreshLiveAttachments(tab.id); } catch { return null; }
    const attachments = attachmentController.composePayload();
    const sentAttachments = await attachmentController.buildHistorySnapshot(attachments);
    return { attachments, sentAttachments };
  }

  async function confirmIdentityUnchanged(sendToken, origin, originTab) {
    const confirmedTab = await queryActiveTab();
    const stillCurrent = transitions.isSendCurrent(sendToken, currentIdentity())
      && confirmedTab?.id === originTab.id
      && projectIdFromTab(confirmedTab) === origin.projectId
      && !state.activeRun;
    if (!stillCurrent) view.setStatus(STATUS.CHANGED_WHILE_PREPARING, true);
    return stillCurrent;
  }

  async function reserveRun(sendToken, origin, originTab) {
    const runId = createRunId();
    await request({ type: PROTOCOL.AI_RUN_RESERVE, runId, tabId: originTab.id, projectId: origin.projectId, sessionId: origin.sessionId });
    const stillCurrent = transitions.isSendCurrent(sendToken, currentIdentity()) && state.activeTabId === originTab.id;
    if (!stillCurrent || !transitions.markReserved(sendToken, runId)) {
      transitions.cancelSend(sendToken);
      await request({ type: PROTOCOL.AI_STREAM_CANCEL, runId }).catch(() => {});
      view.setStatus(STATUS.CHANGED_WHILE_RESERVING, true);
      return { runId, ok: false };
    }
    return { runId, ok: true };
  }

  function beginStreamingUi(run, origin, userEntry) {
    state.isStreaming = true;
    view.setStatus('');
    origin.history.push(userEntry);
    view.renderUserMessage(userEntry);
    view.clearComposer();
    view.scrollToBottom();
    const { messageEl, bodyEl } = view.createStreamingMessage();
    resetStream();
    state.stream.messageEl = messageEl;
    state.stream.bodyEl = bodyEl;
    view.updateComposerLockState();
    view.setSendButtonStop(true);
  }

  function settleWithoutDispatch(run) {
    view.finalizeStream(() => view.onStreamFinalize(run), { responseStatus: 'incomplete' });
    runUiController.complete(run);
    view.setStatus(STATUS.STOPPED);
  }

  function dispatchRun({ runId, originTab, origin, modelConfig, attachments, activeEditorFile }) {
    request({
      type: PROTOCOL.AI_STREAM_START,
      runId,
      tabId: originTab.id,
      projectId: origin.projectId,
      sessionId: origin.sessionId,
      messages: origin.history,
      settings: state.settings,
      modelConfig,
      attachments,
      activeEditorFile
    }).then(result => {
      if (result?.ok === false && state.activeRun?.runId === runId && state.isStreaming) {
        view.failStream(result.error || 'Run failed', view.setStatus);
        runUiController.complete(state.activeRun);
      }
    }).catch(async error => {
      await request({ type: PROTOCOL.AI_STREAM_CANCEL, runId }).catch(() => {});
      if (state.activeRun?.runId === runId && state.isStreaming) {
        view.failStream(error.message, view.setStatus);
        runUiController.complete(state.activeRun);
      }
    });
  }

  async function send() {
    if (state.isStreaming) {
      await stopActiveRun();
      return;
    }
    if (!canStart()) return;
    const text = view.readComposerText();
    if (!text) return;
    const modelConfig = getActiveModel();
    if (!modelConfig) { view.setStatus(STATUS.NO_MODEL, true); return; }

    const origin = {
      session: state.currentSession,
      sessionId: state.currentSession?.id || null,
      projectId: state.currentProjectId,
      history: state.chatHistory
    };
    const sendToken = transitions.beginSend({ projectId: origin.projectId, sessionId: origin.sessionId, history: origin.history });
    if (!sendToken) return;
    view.updateComposerLockState();

    let startedRun = null;
    let reservedRunId = null;
    try {
      const originTab = await captureOriginTab(origin);
      if (!originTab) return;
      const activeEditorFile = await captureFileIdentity(originTab);
      if (!activeEditorFile) return;
      const prepared = await prepareAttachments(originTab);
      if (!prepared) return;
      if (!await confirmIdentityUnchanged(sendToken, origin, originTab)) return;

      const userEntry = { role: 'user', content: text, activeEditorFile };
      if (prepared.sentAttachments.selections.length || prepared.sentAttachments.previews.length) {
        userEntry.sentAttachments = prepared.sentAttachments;
      }
      const reservation = await reserveRun(sendToken, origin, originTab);
      reservedRunId = reservation.runId;
      if (!reservation.ok) return;

      startedRun = runUiController.begin({
        runId: reservation.runId,
        tabId: originTab.id,
        projectId: origin.projectId,
        sessionId: origin.sessionId,
        history: origin.history
      });
      beginStreamingUi(startedRun, origin, userEntry);

      await saveSessionSnapshot(origin.sessionId, origin.history);
      if (state.activeRun !== startedRun) return;
      if (!transitions.canDispatch(sendToken)) { settleWithoutDispatch(startedRun); return; }

      view.maybeAutoNameSession({ session: origin.session, history: origin.history }).catch(error => {
        view.setStatus(`Chat auto-name failed: ${error?.message || String(error)}`, true);
      });

      if (!transitions.markStarting(sendToken)) { settleWithoutDispatch(startedRun); return; }
      dispatchRun({ runId: reservation.runId, originTab, origin, modelConfig, attachments: prepared.attachments, activeEditorFile });
    } catch (error) {
      if (reservedRunId) await request({ type: PROTOCOL.AI_STREAM_CANCEL, runId: reservedRunId }).catch(() => {});
      if (startedRun && state.activeRun === startedRun) {
        if (state.isStreaming) {
          if (transitions.canDispatch(sendToken)) view.failStream(error.message || String(error), view.setStatus);
          else view.finalizeStream(() => view.onStreamFinalize(startedRun), { responseStatus: 'incomplete' });
        }
        runUiController.complete(startedRun);
      } else {
        view.setStatus(error.message || String(error), true);
      }
    } finally {
      transitions.endSend(sendToken);
      view.updateComposerLockState();
    }
  }

  return Object.freeze({ send, STATUS });
}
