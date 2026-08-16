import { TYPST_APP_PREFIX } from '../shared/constants.js';
import {
  DEFAULT_EDIT_FILE_LABEL, EDIT_CHECKPOINT_STATUSES, publicEditCheckpoint, sha256Text
} from '../shared/edit-checkpoint.js';
import { PROTOCOL, buildRequest, unwrapResponse } from '../shared/protocol.js';
import {
  beginEditCheckpointRevert, commitEditCheckpoint, loadEditCheckpoint,
  loadEditCheckpointCascade, markEditCheckpointReverted,
  restoreEditCheckpointApplied, rollbackEditCheckpointPreparation
} from './storage.js';
import { editorFileLabel } from './edit-preview.js';

function defaultAdapters() {
  return {
    tabsGet: tabId => chrome.tabs.get(tabId),
    sendPageRequest: async (tabId, type, payload, options = {}) => {
      const response = await chrome.tabs.sendMessage(tabId, buildRequest(type, payload, options));
      return unwrapResponse(response);
    },
    loadEditCheckpoint,
    loadEditCheckpointCascade,
    commitEditCheckpoint,
    rollbackEditCheckpointPreparation,
    beginEditCheckpointRevert,
    restoreEditCheckpointApplied,
    markEditCheckpointReverted,
    sha256Text,
    createId: () => crypto.randomUUID()
  };
}

export async function revertEditCheckpoint(payload, options = {}) {
  const adapters = { ...defaultAdapters(), ...(options.adapters || {}) };
  if ((options.activeRuns || []).some(run => run.tabId === payload.tabId)) {
    throw coded('EDIT_REVERT_RUN_ACTIVE', 'Wait for the active agent run on this tab to finish before reverting it.');
  }
  await assertTabScope(adapters, payload.tabId, payload.projectId);

  const cascade = await adapters.loadEditCheckpointCascade(payload.checkpointId);
  if (!Array.isArray(cascade) || cascade.length === 0 || cascade[0]?.id !== payload.checkpointId) {
    throw coded('EDIT_CHECKPOINT_NOT_FOUND', 'This revert checkpoint has expired or is no longer available.');
  }
  for (const checkpoint of cascade) assertCheckpointScope(checkpoint, payload);

  const completed = [];
  let revertedCount = 0;
  let changedCount = 0;
  const newestFirst = cascade.slice().reverse();
  for (const candidate of newestFirst) {
    if (candidate.status === EDIT_CHECKPOINT_STATUSES.REVERTED) {
      const summary = publicEditCheckpoint(candidate);
      if (summary) completed.push(summary);
      continue;
    }
    try {
      const outcome = await revertSingleCheckpoint(adapters, candidate, payload);
      if (outcome.checkpoint) completed.push(outcome.checkpoint);
      if (outcome.reverted) revertedCount += 1;
      if (outcome.changed) changedCount += 1;
    } catch (error) {
      throw cascadeFailure(error, {
        selectedCheckpointId: payload.checkpointId,
        failedCheckpointId: candidate.id,
        completed,
        revertedCount,
        totalCount: newestFirst.length
      });
    }
  }

  const checkpoint = completed.find(item => item.id === payload.checkpointId)
    || publicEditCheckpoint(cascade[0]);
  return {
    ok: true,
    checkpoint,
    checkpoints: completed,
    revertedCount,
    alreadyReverted: changedCount === 0
  };
}

async function revertSingleCheckpoint(adapters, initialCheckpoint, payload) {
  let checkpoint = initialCheckpoint;
  if (checkpoint.status === EDIT_CHECKPOINT_STATUSES.REVERTED) {
    return { checkpoint: publicEditCheckpoint(checkpoint), reverted: false, changed: false };
  }

  let context = await readEditContext(adapters, payload.tabId);
  assertFocusedFile(checkpoint, context);
  let currentHash = await adapters.sha256Text(context.fullText);
  ({ checkpoint, context, currentHash } = await reconcileInterruptedCheckpoint(
    adapters, checkpoint, context, currentHash, payload
  ));
  if (checkpoint.status === EDIT_CHECKPOINT_STATUSES.REVERTED) {
    return { checkpoint: publicEditCheckpoint(checkpoint), reverted: true, changed: false };
  }
  if (checkpoint.status !== EDIT_CHECKPOINT_STATUSES.APPLIED) {
    throw coded('EDIT_CHECKPOINT_STATE_INVALID', 'This edit checkpoint is not available for revert.');
  }
  if (typeof checkpoint.beforeText !== 'string') {
    throw coded('EDIT_CHECKPOINT_BODY_MISSING', 'The original document snapshot has expired or is unavailable.');
  }
  const snapshotHash = await adapters.sha256Text(checkpoint.beforeText);
  if (!matchesState(checkpoint.beforeHash, checkpoint.beforeLength, snapshotHash, checkpoint.beforeText.length)) {
    throw coded('EDIT_CHECKPOINT_BODY_INVALID', 'The original document snapshot failed its integrity check.');
  }

  if (matchesState(checkpoint.beforeHash, checkpoint.beforeLength, currentHash, context.fullText.length)) {
    const summary = await adapters.markEditCheckpointReverted(checkpoint.id);
    return { checkpoint: summary, reverted: true, changed: false };
  }
  if (!matchesState(checkpoint.afterHash, checkpoint.afterLength, currentHash, context.fullText.length)) {
    throw conflict();
  }

  await assertTabScope(adapters, payload.tabId, payload.projectId);
  await adapters.beginEditCheckpointRevert(checkpoint.id);
  const runId = `revert-${adapters.createId()}`;
  try {
    const response = await adapters.sendPageRequest(payload.tabId, PROTOCOL.PAGE_APPLY_EDIT, {
      expectedText: context.fullText,
      expectedEditorToken: context.editorToken,
      expectedFileLabel: checkpoint.fileLabel,
      changes: [{ from: 0, to: context.fullText.length, insert: checkpoint.beforeText }],
      callId: `revert-${checkpoint.id}`
    }, { runId });
    const result = response?.result || response;
    if (result?.ok !== true) {
      throw coded(result?.code || 'EDIT_REVERT_FAILED', result?.error || 'The Typst editor rejected the revert transaction.');
    }
    const summary = await adapters.markEditCheckpointReverted(checkpoint.id);
    return { checkpoint: summary, reverted: true, changed: true };
  } catch (error) {
    await adapters.restoreEditCheckpointApplied(checkpoint.id).catch(() => {});
    throw error;
  }
}

async function reconcileInterruptedCheckpoint(adapters, checkpoint, context, currentHash, payload) {
  if (checkpoint.status === EDIT_CHECKPOINT_STATUSES.PREPARED) {
    if (matchesState(checkpoint.pendingAfterHash, checkpoint.pendingAfterLength, currentHash, context.fullText.length)) {
      await adapters.commitEditCheckpoint(checkpoint.id);
    } else if (matchesState(checkpoint.previousAfterHash, checkpoint.previousAfterLength, currentHash, context.fullText.length)) {
      const hadAppliedState = checkpoint.previousStatus === EDIT_CHECKPOINT_STATUSES.APPLIED;
      await adapters.rollbackEditCheckpointPreparation(checkpoint.id);
      if (!hadAppliedState) throw coded('EDIT_CHECKPOINT_NOT_APPLIED', 'The staged editor change was never applied, so there is nothing to revert.');
    } else {
      throw conflict();
    }
    checkpoint = await adapters.loadEditCheckpoint(checkpoint.id);
    if (!checkpoint) throw coded('EDIT_CHECKPOINT_NOT_FOUND', 'This revert checkpoint is no longer available.');
    assertCheckpointScope(checkpoint, payload);
  }

  if (checkpoint.status === EDIT_CHECKPOINT_STATUSES.REVERTING) {
    if (matchesState(checkpoint.beforeHash, checkpoint.beforeLength, currentHash, context.fullText.length)) {
      const summary = await adapters.markEditCheckpointReverted(checkpoint.id);
      return { checkpoint: { ...checkpoint, ...summary, status: EDIT_CHECKPOINT_STATUSES.REVERTED }, context, currentHash };
    }
    if (!matchesState(checkpoint.afterHash, checkpoint.afterLength, currentHash, context.fullText.length)) throw conflict();
    await adapters.restoreEditCheckpointApplied(checkpoint.id);
    checkpoint = await adapters.loadEditCheckpoint(checkpoint.id);
    if (!checkpoint) throw coded('EDIT_CHECKPOINT_NOT_FOUND', 'This revert checkpoint is no longer available.');
  }
  return { checkpoint, context, currentHash };
}

async function readEditContext(adapters, tabId) {
  const context = await adapters.sendPageRequest(tabId, PROTOCOL.PAGE_GET_CONTEXT, { projection: 'edit' });
  if (!context || typeof context.fullText !== 'string' || typeof context.editorToken !== 'string' || !context.editorToken) {
    throw coded('EDIT_CONTEXT_UNAVAILABLE', 'The live Typst editor could not be read for a guarded revert.');
  }
  return context;
}

function assertFocusedFile(checkpoint, context) {
  if (checkpoint.fileLabel !== DEFAULT_EDIT_FILE_LABEL && editorFileLabel(context.workspace) !== checkpoint.fileLabel) {
    throw coded('EDIT_REVERT_FILE_MISMATCH', 'A revert step targets a different Typst file. Reopen the required file and retry.');
  }
}

async function assertTabScope(adapters, tabId, projectId) {
  const tab = await adapters.tabsGet(tabId);
  if (!tab?.url?.startsWith(TYPST_APP_PREFIX)) throw coded('NOT_TYPST_TAB', 'The selected tab is no longer a typst.app page.');
  const match = tab.url.match(/typst\.app\/project\/([^/?#]+)/);
  if (!match || match[1] !== projectId) throw coded('EDIT_REVERT_PROJECT_MISMATCH', 'The selected tab no longer shows the project that owns this checkpoint.');
}

function assertCheckpointScope(checkpoint, payload) {
  if (checkpoint.projectId !== payload.projectId || checkpoint.sessionId !== payload.sessionId) {
    throw coded('EDIT_REVERT_SCOPE_MISMATCH', 'This checkpoint belongs to a different project or chat session.');
  }
}

function matchesState(expectedHash, expectedLength, actualHash, actualLength) {
  return typeof expectedHash === 'string' && expectedHash === actualHash && expectedLength === actualLength;
}

function conflict() {
  return coded('EDIT_REVERT_CONFLICT', 'The document does not match the expected state for this revert step. The cascade stopped so unverified older work remains untouched.');
}

function cascadeFailure(error, details) {
  const completed = Array.isArray(details.completed) ? details.completed : [];
  const count = Number(details.revertedCount) || 0;
  const prefix = count > 0
    ? `${count} newer response${count === 1 ? ' was' : 's were'} reverted, but the cascade stopped: `
    : '';
  return coded(error?.code || 'EDIT_REVERT_FAILED', `${prefix}${error?.message || String(error)}`, {
    selectedCheckpointId: details.selectedCheckpointId,
    failedCheckpointId: details.failedCheckpointId,
    checkpoints: completed,
    revertedCount: count,
    totalCount: Number(details.totalCount) || 0
  });
}

function coded(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details != null) error.details = details;
  return error;
}
