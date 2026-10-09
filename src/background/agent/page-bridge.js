/**
 * Run-bound access to the captured typst.app tab: correlated page requests
 * with cancellation, capability probes, and live-document snapshot upkeep.
 */
import { TYPST_APP_PREFIX } from '../../shared/constants.js';
import { PROTOCOL, buildRequest, unwrapResponse } from '../../shared/protocol.js';
import { raceWithSignal, throwIfAborted } from '../../shared/abort.js';
import { activeEditorFileFromContext, editorFileLabel } from '../../shared/active-file.js';
import { DOCUMENT_SNAPSHOT_KINDS } from '../../shared/document-snapshot.js';
import { sha256Text } from '../../shared/edit-checkpoint.js';
import { codedError } from '../../shared/errors.js';
import { adapters } from './agent-adapters.js';

export function cancelled() {
  return codedError('CANCELLED', 'Operation cancelled.');
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const timer = adapters.setTimeoutImpl(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      adapters.clearTimeoutImpl(timer);
      signal.removeEventListener('abort', onAbort);
      reject(cancelled());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Send one correlated request to the captured tab; cancellation also cancels it on the page. */
export async function forwardToTab(run, type, payload = {}) {
  throwIfAborted(run.signal);
  const request = buildRequest(type, payload, { runId: run.runId });
  const cancelRequest = () => {
    const cancellation = buildRequest(PROTOCOL.PAGE_CANCEL_REQUEST, { targetRequestId: request.requestId }, { runId: run.runId });
    Promise.resolve().then(() => adapters.tabsSend(run.tabId, cancellation)).catch(() => {});
  };
  run.signal.addEventListener?.('abort', cancelRequest, { once: true });
  try {
    const response = await raceWithSignal(Promise.resolve(adapters.tabsSend(run.tabId, request)), run.signal);
    throwIfAborted(run.signal);
    return unwrapResponse(response);
  } finally {
    run.signal.removeEventListener?.('abort', cancelRequest);
  }
}

export async function revalidateOriginatingTab(run) {
  const tab = await raceWithSignal(adapters.tabsGet(run.tabId), run.signal);
  return !!tab?.url?.startsWith(TYPST_APP_PREFIX) && tab.url === run.tabUrl;
}

export async function probePageCapabilities(run) {
  try {
    const result = await forwardToTab(run, PROTOCOL.PAGE_GET_PROBE);
    return {
      ok: true,
      editor: !!result?.editor,
      selection: !!result?.selection,
      typstCanvas: !!result?.typstCanvas,
      previewImage: !!result?.previewImage,
      improvePanel: !!result?.improvePanel
    };
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    return { ok: false, error: error.message || String(error) };
  }
}

export async function readLiveDocumentSnapshotState(run) {
  if (!adapters.documentSnapshotsEnabled()) return null;
  const response = await adapters.tabsSend(run.tabId, buildRequest(PROTOCOL.PAGE_GET_CONTEXT, { projection: 'edit' }));
  const context = unwrapResponse(response);
  if (!context || typeof context.fullText !== 'string') {
    throw codedError(
      'DOCUMENT_SNAPSHOT_CONTEXT_UNAVAILABLE',
      context?.error || 'The live Typst editor could not be read for snapshot maintenance.'
    );
  }
  return {
    activeFile: activeEditorFileFromContext(context),
    fileLabel: editorFileLabel(context),
    text: context.fullText,
    textHash: await sha256Text(context.fullText),
    textLength: context.fullText.length
  };
}

export async function invalidateDivergedAutomaticSnapshot(run) {
  const live = await readLiveDocumentSnapshotState(run);
  if (!live) return null;
  const invalidated = await adapters.invalidateAutomaticDocumentSnapshots({
    projectId: run.projectId,
    sessionId: run.sessionId,
    fileLabel: live.fileLabel,
    textHash: live.textHash,
    textLength: live.textLength
  });
  return { ...live, invalidated };
}

export async function createCompletedResponseSnapshot(run) {
  if (!adapters.documentSnapshotsEnabled()) return {};
  try {
    const live = await readLiveDocumentSnapshotState(run);
    if (!live) return {};
    const result = await adapters.createDocumentSnapshot({
      kind: DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC,
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      fileLabel: live.fileLabel,
      text: live.text
    });
    return result?.snapshot ? { snapshot: result.snapshot } : {};
  } catch (error) {
    const reason = error?.message || String(error);
    return { snapshotWarning: `The response completed, but its document snapshot was not saved: ${reason}`.slice(0, 500) };
  }
}
