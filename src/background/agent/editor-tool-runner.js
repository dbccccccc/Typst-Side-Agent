/**
 * Built-in editor writes: resolve the model's edit against a live snapshot,
 * show the reviewed diff when the mode is Ask, stage a revert checkpoint, and
 * commit through one guarded page transaction.
 */
import { EDITOR_APPROVAL_MODES } from '../../shared/constants.js';
import { PROTOCOL, buildRequest } from '../../shared/protocol.js';
import { DEFAULT_EDIT_FILE_LABEL, applyTextChanges, sha256Text } from '../../shared/edit-checkpoint.js';
import { isEditorEditTool, prepareEditorEdit } from '../edit-preview.js';
import { adapters } from './agent-adapters.js';
import { forwardToTab, revalidateOriginatingTab } from './page-bridge.js';
import { authorizeTool, preflightFailure, waitForMessageFile, waitForMessageFileContext } from './tool-preflight.js';

const MAX_FILE_SWITCH_RETRIES = 15;

async function prepareEditorTool(run, call, args) {
  const guarded = await waitForMessageFileContext(run, call, { projection: 'edit' });
  if (!guarded.ok) return preflightFailure(guarded);
  const context = guarded.context;
  if (context?.error) return { ok: false, code: 'EDIT_CONTEXT_UNAVAILABLE', error: context.error };
  return prepareEditorEdit(call.name, args, context);
}

function preparedEditorPayload(callId, prepared, options = {}) {
  const payload = {
    expectedText: prepared.baseText,
    expectedEditorToken: prepared.editorToken,
    expectedFileLabel: prepared.preview?.fileLabel || DEFAULT_EDIT_FILE_LABEL,
    changes: prepared.changes,
    callId
  };
  if (options.includePreview) payload.preview = prepared.preview;
  if (typeof options.reviewedDiff === 'boolean') payload.reviewedDiff = options.reviewedDiff;
  return payload;
}

async function showPreparedEditorPreview(run, call, prepared) {
  for (let attempt = 0; attempt <= MAX_FILE_SWITCH_RETRIES; attempt += 1) {
    const payload = preparedEditorPayload(call.id, prepared, { includePreview: true });
    const response = await forwardToTab(run, PROTOCOL.PAGE_SHOW_EDIT_PREVIEW, payload);
    const result = response?.result || response || { ok: true, shown: false };
    if (result?.code !== 'STALE_EDIT_PREVIEW' || result?.staleReason !== 'file' || !run.activeEditorFile) return result;
    const fileReady = await waitForMessageFile(run, call);
    if (!fileReady.ok) return preflightFailure(fileReady);
  }
  return {
    ok: false,
    code: 'ACTIVE_FILE_RETRY_LIMIT',
    error: 'The open file changed too many times while the editor preview was being prepared.'
  };
}

async function clearPreparedEditorPreview(run, callId) {
  try {
    const request = buildRequest(PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW, { callId }, { runId: run.runId });
    await adapters.tabsSend(run.tabId, request);
  } catch {
    // The tab may have closed or navigated while approval was open.
  }
}

async function stageCheckpoint(run, callId, prepared, baseHash, proposedHash, proposedText) {
  const existing = run.editCheckpoint;
  const checkpointId = existing?.id || `edit-${crypto.randomUUID()}`;
  if (existing?.needsCommit) {
    await adapters.commitEditCheckpoint(checkpointId);
    existing.needsCommit = false;
  }
  const staged = existing
    ? await adapters.prepareEditCheckpointUpdate(checkpointId, {
        callId,
        pendingAfterHash: proposedHash,
        pendingAfterLength: proposedText.length
      })
    : await adapters.stageEditCheckpoint({
        id: checkpointId,
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        callId,
        fileLabel: prepared.preview?.fileLabel,
        beforeText: prepared.baseText,
        beforeHash: baseHash,
        pendingAfterHash: proposedHash,
        pendingAfterLength: proposedText.length
      });
  return { checkpointId, staged };
}

async function executePreparedEditorTool(run, call, prepared, fileRetryCount = 0, reviewedDiff = false) {
  const callId = call.id;
  const proposedText = applyTextChanges(prepared.baseText, prepared.changes);
  const [baseHash, proposedHash] = await Promise.all([sha256Text(prepared.baseText), sha256Text(proposedText)]);
  const existing = run.editCheckpoint;
  if (existing && (
    baseHash !== existing.afterHash ||
    prepared.editorToken !== existing.editorToken ||
    prepared.preview?.fileLabel !== existing.fileLabel
  )) {
    return {
      ok: false,
      code: 'EDIT_CHECKPOINT_CONFLICT',
      error: 'The document changed outside this agent run. The pending edit was not applied so the existing revert point remains safe.'
    };
  }

  let checkpointId;
  let staged;
  try {
    ({ checkpointId, staged } = await stageCheckpoint(run, callId, prepared, baseHash, proposedHash, proposedText));
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'EDIT_CHECKPOINT_FAILED',
      error: `The edit was not applied because a safe revert checkpoint could not be stored: ${error?.message || String(error)}`
    };
  }

  // Delivery failures are ambiguous: the page may have committed just before
  // the worker observed cancellation. In that case the thrown error leaves the
  // write-ahead record intact for hash-based recovery.
  const response = await forwardToTab(run, PROTOCOL.PAGE_APPLY_EDIT, preparedEditorPayload(callId, prepared, { reviewedDiff }));
  const result = response?.result || response || { ok: false, error: 'No page response' };

  if (result.ok === false) {
    await adapters.rollbackEditCheckpointPreparation(checkpointId).catch(() => {});
    if (result.code === 'STALE_EDIT_PREVIEW' && result.staleReason === 'file' && run.activeEditorFile) {
      if (fileRetryCount >= MAX_FILE_SWITCH_RETRIES) {
        return {
          ok: false,
          code: 'ACTIVE_FILE_RETRY_LIMIT',
          error: 'The open file changed too many times while the editor change was being applied.'
        };
      }
      const fileReady = await waitForMessageFile(run, call);
      if (!fileReady.ok) return preflightFailure(fileReady);
      return executePreparedEditorTool(run, call, prepared, fileRetryCount + 1, reviewedDiff);
    }
    return result;
  }

  const checkpoint = {
    id: checkpointId,
    status: 'applied',
    fileLabel: staged.fileLabel || prepared.preview?.fileLabel || DEFAULT_EDIT_FILE_LABEL,
    createdAt: staged.createdAt || adapters.now()
  };
  let warning;
  try {
    Object.assign(checkpoint, await adapters.commitEditCheckpoint(checkpointId));
  } catch (error) {
    warning = `The change was applied, but checkpoint finalization is pending: ${error?.message || String(error)}`;
  }
  run.editCheckpoint = {
    id: checkpointId,
    afterHash: proposedHash,
    afterLength: proposedText.length,
    editorToken: prepared.editorToken,
    fileLabel: checkpoint.fileLabel,
    needsCommit: !!warning
  };
  if (adapters.documentSnapshotsEnabled()) {
    await adapters.deleteAutomaticDocumentSnapshots({
      projectId: run.projectId,
      sessionId: run.sessionId,
      fileLabel: checkpoint.fileLabel
    }).catch(() => {});
  }
  return { ...result, editCheckpoint: checkpoint, ...(warning ? { warning } : {}) };
}

async function runReviewedEditorTool(run, call, route, args, prepared) {
  try {
    let inlinePreview;
    try {
      const fileReady = await waitForMessageFile(run, call);
      if (!fileReady.ok) return preflightFailure(fileReady);
      inlinePreview = await showPreparedEditorPreview(run, call, prepared);
    } catch (error) {
      if (error.code === 'CANCELLED') throw error;
      inlinePreview = { ok: true, shown: false, warning: `The inline editor preview is unavailable: ${error?.message || String(error)}` };
    }
    if (inlinePreview?.ok === false) {
      return {
        ok: false,
        code: inlinePreview.code || 'EDIT_PREVIEW_FAILED',
        error: inlinePreview.error || 'Could not show the prepared edit in CodeMirror.'
      };
    }
    const previewNotice = inlinePreview?.warning || (!inlinePreview?.shown
      ? 'The inline editor preview could not be displayed. Review the complete diff below.'
      : '');
    const authorization = await authorizeTool(run, call, route, args, prepared.preview, previewNotice);
    if (!authorization.ok) return { ok: false, code: authorization.error.code, error: authorization.error.message };
    if (!await revalidateOriginatingTab(run)) {
      return { ok: false, code: 'STALE_RUN_TAB', error: 'The originating Typst tab navigated while the edit was awaiting approval.' };
    }
    const fileReady = await waitForMessageFile(run, call);
    if (!fileReady.ok) return preflightFailure(fileReady);
    return await executePreparedEditorTool(run, call, prepared, 0, true);
  } finally {
    await clearPreparedEditorPreview(run, call.id);
  }
}

/** Execute one built-in editor write under the run's captured approval mode. */
export async function runEditorTool(run, call, route, args) {
  if (!isEditorEditTool(call.name)) return { ok: false, code: 'UNSUPPORTED_EDIT_TOOL', error: `Cannot preview editor tool: ${call.name}` };
  if (!await revalidateOriginatingTab(run)) {
    return { ok: false, code: 'STALE_RUN_TAB', error: 'The originating Typst tab navigated after this run began.' };
  }
  const prepared = await prepareEditorTool(run, call, args);
  if (!prepared.ok) return { ok: false, code: prepared.code || 'EDIT_PREVIEW_FAILED', error: prepared.error || 'Could not prepare edit preview.' };
  if (prepared.noChanges) return prepared.result;
  if (run.editorApprovalMode === EDITOR_APPROVAL_MODES.AUTO) {
    if (!await revalidateOriginatingTab(run)) {
      return { ok: false, code: 'STALE_RUN_TAB', error: 'The originating Typst tab navigated before the editor change could be applied.' };
    }
    const fileReady = await waitForMessageFile(run, call);
    if (!fileReady.ok) return preflightFailure(fileReady);
    return executePreparedEditorTool(run, call, prepared);
  }
  return runReviewedEditorTool(run, call, route, args, prepared);
}
