/**
 * Response-level recovery controls: the guarded Revert action with its
 * in-panel confirmation, and the Snapshot action on the latest completed response.
 */
import { PROTOCOL } from '../shared/protocol.js';
import {
  DEFAULT_EDIT_FILE_LABEL, isEditCheckpointToolName, latestEditCheckpointFromMessage, normalizePublicEditCheckpoint
} from '../shared/edit-checkpoint.js';
import { state, bg } from './state.js';
import { $, iconElement, svgIcon } from './chat-dom.js';

const REVERT_ICONS = Object.freeze({
  success: svgIcon(15, 2.25, '<path d="m5 12 4 4L19 6"/>'),
  unavailable: svgIcon(15, 2, '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'),
  action: svgIcon(12, 2.25, '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 1 1-7 7"/>')
});
const SNAPSHOT_ICON = svgIcon(13, 2, '<path d="M4 7h3l1.5-2h7L17 7h3v12H4Z"/><circle cx="12" cy="13" r="3"/>');
const SNAPSHOT_TITLE = 'Open the document snapshot saved after this completed response.';

const checkpointControlRenderers = new WeakMap();
let responseRecoveryActions = Object.freeze({ openSnapshots: async () => {} });
let pendingRevertConfirmation = null;
let revertDialogInitialized = false;

export function configureResponseRecoveryActions(actions = {}) {
  responseRecoveryActions = Object.freeze({
    openSnapshots: typeof actions.openSnapshots === 'function' ? actions.openSnapshots : async () => {}
  });
}

export function latestEditCheckpoint(msg) {
  return latestEditCheckpointFromMessage(msg);
}

export function updateEditCheckpointInHistory(history, checkpoint) {
  let updated = 0;
  for (const message of Array.isArray(history) ? history : []) {
    for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
      if (segment?.type !== 'tools') continue;
      for (const call of Array.isArray(segment.calls) ? segment.calls : []) {
        if (!isEditCheckpointToolName(call?.name)) continue;
        const result = segment.results?.[call.id];
        if (result?.editCheckpoint?.id === checkpoint.id) {
          result.editCheckpoint = { ...result.editCheckpoint, ...checkpoint };
          updated += 1;
        }
      }
    }
  }
  return updated;
}

function normalizeCheckpointSummaries(values, fallback = null) {
  const candidates = Array.isArray(values) ? values.slice() : [];
  if (fallback) candidates.push(fallback);
  const summaries = [];
  const seen = new Set();
  for (const value of candidates) {
    const checkpoint = normalizePublicEditCheckpoint(value);
    if (!checkpoint || seen.has(checkpoint.id)) continue;
    seen.add(checkpoint.id);
    summaries.push(checkpoint);
  }
  return summaries;
}

function checkpointTargetLabel(checkpoint) {
  return checkpoint.fileLabel === DEFAULT_EDIT_FILE_LABEL ? 'the current Typst document' : checkpoint.fileLabel;
}

function createResponseActionButton({ className, label, title, icon, busy = false, disabled = false }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `response-action-button ${className}`;
  button.title = title;
  button.dataset.busy = busy ? 'true' : 'false';
  button.disabled = disabled || busy;
  const marker = iconElement('response-action-icon', busy ? '' : icon);
  if (busy) {
    const spinner = document.createElement('span');
    spinner.className = 'edit-revert-button-spinner';
    marker.appendChild(spinner);
  }
  const text = document.createElement('span');
  text.textContent = label;
  button.append(marker, text);
  return button;
}

function createSnapshotButton(disabled) {
  const button = createResponseActionButton({
    className: 'response-snapshot-button', label: 'Snapshot', title: SNAPSHOT_TITLE, icon: SNAPSHOT_ICON, disabled
  });
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  return button;
}

function createRevertStatus(checkpoint) {
  const status = document.createElement('span');
  const reverted = checkpoint.status === 'reverted';
  status.className = `edit-revert-status is-${reverted ? 'success' : 'unavailable'}`;
  status.title = reverted
    ? `Restored ${checkpointTargetLabel(checkpoint)} to its state before this response.`
    : checkpoint.unavailableReason || 'Revert data is unavailable.';
  const label = document.createElement('span');
  label.className = reverted ? 'edit-revert-success' : '';
  label.textContent = reverted ? 'Changes reverted' : 'Revert unavailable';
  status.append(iconElement('response-action-icon', reverted ? REVERT_ICONS.success : REVERT_ICONS.unavailable), label);
  return status;
}

function appendRevertPersistenceNote(control, message) {
  const note = document.createElement('div');
  note.className = 'edit-revert-note';
  note.setAttribute('role', 'alert');
  const marker = document.createElement('span');
  marker.className = 'edit-revert-note-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.textContent = '!';
  const copy = document.createElement('span');
  copy.className = 'edit-revert-note-copy edit-revert-error';
  copy.textContent = message;
  note.append(marker, copy);
  control.appendChild(note);
}

function syncRenderedCheckpointControls(checkpoints) {
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== 'reverted') continue;
    for (const control of document.querySelectorAll('.edit-revert-control')) {
      if (control.dataset.checkpointId !== checkpoint.id) continue;
      checkpointControlRenderers.get(control)?.(checkpoint);
    }
  }
}

function closeRevertConfirmation({ restoreFocus = false } = {}) {
  const pending = pendingRevertConfirmation;
  pendingRevertConfirmation = null;
  const layer = $('revert-dialog-layer');
  layer?.classList.add('hidden');
  layer?.removeAttribute('data-checkpoint-id');
  pending?.trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && pending?.trigger?.isConnected) pending.trigger.focus();
}

export function resetRevertConfirmation() {
  closeRevertConfirmation();
}

function ensureRevertDialogInitialized() {
  if (revertDialogInitialized) return;
  const layer = $('revert-dialog-layer');
  const close = $('revert-dialog-close');
  const cancel = $('revert-dialog-cancel');
  const confirm = $('revert-dialog-confirm');
  if (!layer || !close || !cancel || !confirm) return;
  revertDialogInitialized = true;

  close.addEventListener('click', () => closeRevertConfirmation({ restoreFocus: true }));
  cancel.addEventListener('click', () => closeRevertConfirmation({ restoreFocus: true }));
  layer.addEventListener('click', event => {
    if (event.target === layer) closeRevertConfirmation({ restoreFocus: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !layer.classList.contains('hidden')) {
      event.preventDefault();
      closeRevertConfirmation({ restoreFocus: true });
    }
  });
  confirm.addEventListener('click', () => {
    const pending = pendingRevertConfirmation;
    if (!pending) return;
    closeRevertConfirmation();
    Promise.resolve(pending.onConfirm()).catch(error => pending.onError(error));
  });
}

function openRevertConfirmation({ trigger, checkpoint, onConfirm, onError }) {
  ensureRevertDialogInitialized();
  const layer = $('revert-dialog-layer');
  const subtitle = $('revert-dialog-subtitle');
  const body = $('revert-dialog-body');
  const confirm = $('revert-dialog-confirm');
  if (!layer || !subtitle || !body || !confirm) {
    onError(new Error('The Revert confirmation could not be opened.'));
    return;
  }

  closeRevertConfirmation();
  pendingRevertConfirmation = { trigger, onConfirm, onError };
  trigger.setAttribute('aria-expanded', 'true');
  layer.dataset.checkpointId = checkpoint.id;
  subtitle.textContent = checkpointTargetLabel(checkpoint);

  const warning = document.createElement('div');
  warning.className = 'snapshot-dialog-note is-warning';
  warning.textContent = `Restore ${checkpointTargetLabel(checkpoint)} to its state before this response.`;
  const detail = document.createElement('div');
  detail.className = 'revert-dialog-detail';
  detail.textContent = 'Any later agent edits in this chat will be reverted first, newest to oldest. '
    + 'Reverting stops if a step no longer matches the live document.';
  body.replaceChildren(warning, detail);

  layer.classList.remove('hidden');
  confirm.focus();
}

function revertScopeIsCurrent(scope) {
  return !state.isStreaming && state.activeTabOnTypst
    && state.activeTabId === scope.tabId
    && state.currentProjectId === scope.projectId
    && state.currentSession?.id === scope.sessionId
    && state.currentSession?.projectId === scope.projectId
    && state.chatHistory === scope.history;
}

/**
 * Render the compact Revert / Snapshot actions beneath a response. Returns null
 * when the response neither edited the editor nor is the latest completed one.
 */
export function renderEditCheckpointControl(msg, { showSnapshot = false } = {}) {
  let checkpoint = latestEditCheckpoint(msg);
  if (!checkpoint && !showSnapshot) return null;
  const control = document.createElement('div');
  control.className = 'edit-revert-control response-recovery-control';
  if (checkpoint) control.dataset.checkpointId = checkpoint.id;
  control.dataset.hasSnapshot = showSnapshot ? 'true' : 'false';

  const render = (notice = '') => {
    const actionDisabled = state.isStreaming || !state.activeTabOnTypst;
    const viewState = notice
      ? 'error'
      : checkpoint?.status === 'reverted' ? 'success' : checkpoint?.status === 'unavailable' ? 'unavailable' : 'available';
    control.className = `edit-revert-control response-recovery-control is-${viewState}`;
    control.dataset.revertState = viewState;
    control.setAttribute('aria-busy', 'false');
    control.replaceChildren();

    const actions = document.createElement('div');
    actions.className = 'response-recovery-actions';
    if (checkpoint) {
      if (checkpoint.status === 'reverted' || checkpoint.status === 'unavailable') {
        actions.appendChild(createRevertStatus(checkpoint));
      } else {
        const button = createResponseActionButton({
          className: 'edit-revert-button',
          label: notice ? 'Try revert again' : 'Revert',
          title: `Restore ${checkpointTargetLabel(checkpoint)} to its state before this response. Later agent edits in this chat are reverted first.`,
          icon: REVERT_ICONS.action,
          disabled: actionDisabled
        });
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => requestRevert(button));
        actions.appendChild(button);
      }
    }
    if (control.dataset.hasSnapshot === 'true') {
      const snapshot = createSnapshotButton(actionDisabled);
      snapshot.addEventListener('click', () => {
        Promise.resolve(responseRecoveryActions.openSnapshots(snapshot)).catch(() => {});
      });
      actions.appendChild(snapshot);
    }
    control.appendChild(actions);
    if (notice) appendRevertPersistenceNote(control, notice);
  };

  function requestRevert(trigger) {
    const scope = Object.freeze({
      tabId: state.activeTabId,
      projectId: state.currentProjectId,
      sessionId: state.currentSession?.id,
      history: state.chatHistory
    });
    const scopeComplete = Number.isInteger(scope.tabId) && scope.projectId && scope.sessionId
      && state.currentSession?.projectId === scope.projectId;
    if (state.isStreaming || !state.activeTabOnTypst || !scopeComplete) {
      render('Open the matching Typst project and chat before reverting.');
      return;
    }
    openRevertConfirmation({
      trigger,
      checkpoint,
      onConfirm: () => executeRevert(scope),
      onError: error => render(error?.message || String(error))
    });
  }

  function renderBusy() {
    control.className = 'edit-revert-control response-recovery-control is-busy';
    control.dataset.revertState = 'busy';
    control.setAttribute('aria-busy', 'true');
    const actions = document.createElement('div');
    actions.className = 'response-recovery-actions';
    actions.appendChild(createResponseActionButton({
      className: 'edit-revert-button',
      label: 'Reverting…',
      title: 'Reverting later agent edits first, then this response.',
      icon: REVERT_ICONS.action,
      busy: true,
      disabled: true
    }));
    if (control.dataset.hasSnapshot === 'true') actions.appendChild(createSnapshotButton(true));
    control.replaceChildren(actions);
  }

  async function saveHistory(sessionId, history) {
    await bg({ type: PROTOCOL.SESSION_UPDATE, sessionId, messages: history });
  }

  async function executeRevert(scope) {
    if (!revertScopeIsCurrent(scope)) {
      render('The active Typst project or chat changed. Open Revert again.');
      return;
    }
    const { tabId, projectId, sessionId, history } = scope;
    renderBusy();
    try {
      const response = await bg({ type: PROTOCOL.EDIT_CHECKPOINT_REVERT, checkpointId: checkpoint.id, tabId, projectId, sessionId });
      const checkpoints = normalizeCheckpointSummaries(response?.checkpoints, response?.checkpoint || { ...checkpoint, status: 'reverted' });
      for (const summary of checkpoints) updateEditCheckpointInHistory(history, summary);
      checkpoint = checkpoints.find(summary => summary.id === checkpoint.id) || checkpoint;
      syncRenderedCheckpointControls(checkpoints);
      try {
        await saveHistory(sessionId, history);
      } catch (error) {
        appendRevertPersistenceNote(control, `Changes were reverted, but chat status was not saved: ${error?.message || String(error)}`);
      }
    } catch (error) {
      const completed = normalizeCheckpointSummaries(error?.details?.checkpoints);
      for (const summary of completed) updateEditCheckpointInHistory(history, summary);
      syncRenderedCheckpointControls(completed);
      let saveError = null;
      if (completed.length) {
        try { await saveHistory(sessionId, history); }
        catch (caught) { saveError = caught; }
      }
      render(error?.message || String(error));
      if (saveError) {
        appendRevertPersistenceNote(control, `Completed revert status was not saved to chat: ${saveError?.message || String(saveError)}`);
      }
    }
  }

  if (checkpoint) {
    checkpointControlRenderers.set(control, summary => {
      checkpoint = { ...checkpoint, ...summary };
      render();
    });
  }
  render();
  return control;
}

/** Only the latest completed response offers Snapshot; older rendered actions are removed. */
export function clearRenderedSnapshotActions() {
  for (const button of document.querySelectorAll('.response-snapshot-button')) {
    const control = button.closest('.response-recovery-control');
    const actions = button.closest('.response-recovery-actions');
    if (control) control.dataset.hasSnapshot = 'false';
    button.remove();
    if (actions && actions.children.length === 0) control?.remove();
  }
}
