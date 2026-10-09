/**
 * Everything a tool call may have to wait for before it runs: page
 * capabilities, the message file being open again, the Files sidebar, a
 * requested project file, and the user's approval decision.
 */
import { PROTOCOL } from '../../shared/protocol.js';
import { throwIfAborted } from '../../shared/abort.js';
import { activeEditorFileFromContext, sameActiveEditorFile } from '../../shared/active-file.js';
import { projectTreeFromContext } from '../../shared/project-tree.js';
import { adapters } from './agent-adapters.js';
import { cancelled, forwardToTab, probePageCapabilities } from './page-bridge.js';
import { emit } from './run-events.js';

const PREFLIGHT_TIMEOUT_MS = 5 * 60_000;
const PREFLIGHT_RECHECK_MS = 1500;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_ACTIONS = ['approve_once', 'allow_run', 'deny'];
const IDENTITY_PROBE = { projection: 'numbered', startLine: 1, endLine: 1, maxChars: 1 };

const TOOL_PREFLIGHT = Object.freeze({
  read_document: { caps: ['editor'], hint: 'Open a Typst (.typ) file in the originating typst.app tab.' },
  read_diagnostics: { caps: ['editor', 'improvePanel'], hint: 'Open the Improve panel in the originating typst.app tab.' },
  replace_lines: { caps: ['editor'], hint: 'Open the Typst editor for the file you want to edit.' },
  search_replace: { caps: ['editor'], hint: 'Open the Typst editor for the file you want to edit.' },
  patch_document: { caps: ['editor'], hint: 'Open the Typst editor for the file you want to edit.' },
  insert_at_cursor: { caps: ['editor'], hint: 'Place the cursor in the originating Typst editor.' },
  replace_selection: { caps: ['editor', 'selection'], hint: 'Select the text in the originating Typst editor, then retry.' }
});

const preflightWaiters = new Map();
const approvalWaiters = new Map();

function waiterKey(runId, callId) {
  return `${runId}\u0000${callId}`;
}

function resolveWaiter(map, key, action) {
  const waiter = map.get(key);
  if (!waiter) return false;
  waiter.resolve(action);
  return true;
}

export function resolvePreflight(runId, callId, action) {
  return resolveWaiter(preflightWaiters, waiterKey(runId, callId), action === 'cancel' ? 'cancel' : 'retry');
}

export function resolveApproval(runId, callId, action) {
  if (!APPROVAL_ACTIONS.includes(action)) return false;
  return resolveWaiter(approvalWaiters, waiterKey(runId, callId), action);
}

/** Settle every waiter of a run so no promise outlives its terminal event. */
export function cleanupRunWaiters(runId, value = 'cancel') {
  const prefix = `${runId}\u0000`;
  for (const [key, waiter] of preflightWaiters) if (key.startsWith(prefix)) waiter.resolve(value);
  for (const [key, waiter] of approvalWaiters) if (key.startsWith(prefix)) waiter.resolve(value === 'cancel' ? 'deny' : value);
}

export function waitForUserOrTimer(map, key, timeoutMs, signal, timeoutAction = 'tick') {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      adapters.clearTimeoutImpl(timer);
      signal?.removeEventListener?.('abort', onAbort);
      map.delete(key);
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      adapters.clearTimeoutImpl(timer);
      map.delete(key);
      reject(cancelled());
    };
    const timer = adapters.setTimeoutImpl(() => finish(timeoutAction), timeoutMs);
    map.set(key, { resolve: finish });
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function preflightFailure(result) {
  return { ok: false, code: result.error.code, error: result.error.message };
}

/**
 * Shared polling loop: emit one waiting event, then re-check after each user
 * action or timer tick until `check` succeeds, the user skips, or the wait
 * times out.
 */
async function waitUntil(run, call, { check, describe, missing, timeoutCode, timeoutLabel }) {
  const startedAt = adapters.now();
  let announced = false;
  while (true) {
    throwIfAborted(run.signal);
    const outcome = await check();
    if (outcome.ok) {
      if (announced) emit(run, PROTOCOL.AI_TOOL_PREFLIGHT_READY, { callId: call.id });
      return outcome;
    }
    const hint = describe(outcome);
    emit(run, PROTOCOL.AI_TOOL_PREFLIGHT_WAITING, {
      callId: call.id,
      name: call.name,
      missing: missing(outcome),
      hint
    });
    announced = true;
    if (adapters.now() - startedAt > PREFLIGHT_TIMEOUT_MS) {
      return { ok: false, error: { code: timeoutCode, message: `${timeoutLabel} ${hint}` } };
    }
    const action = await waitForUserOrTimer(preflightWaiters, waiterKey(run.runId, call.id), PREFLIGHT_RECHECK_MS, run.signal);
    if (action === 'cancel') {
      return { ok: false, error: { code: 'PREFLIGHT_DENIED', message: `User skipped this tool call. ${hint}` } };
    }
  }
}

async function readContext(run, payload) {
  try {
    const context = await forwardToTab(run, PROTOCOL.PAGE_GET_CONTEXT, payload);
    return { context, contextError: typeof context?.error === 'string' ? context.error : '' };
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    return { context: null, contextError: error?.message || String(error) };
  }
}

export async function waitForCapabilities(run, call) {
  const spec = TOOL_PREFLIGHT[call.name];
  if (!spec) return { ok: true };
  return waitUntil(run, call, {
    async check() {
      const probe = await probePageCapabilities(run);
      const missing = probe.ok ? spec.caps.filter(cap => !probe[cap]) : [...spec.caps];
      return missing.length ? { ok: false, probe, missing } : { ok: true };
    },
    describe: ({ probe }) => (probe.ok ? spec.hint : `The originating tab is unavailable (${probe.error}).`),
    missing: ({ missing }) => missing,
    timeoutCode: 'PREFLIGHT_TIMEOUT',
    timeoutLabel: 'Preflight timed out.'
  });
}

/** Read a context only once the send-time message file is the open file again. */
export async function waitForMessageFileContext(run, call, contextPayload) {
  const expected = run.activeEditorFile;
  if (!expected) {
    return { ok: true, context: await forwardToTab(run, PROTOCOL.PAGE_GET_CONTEXT, contextPayload) };
  }
  const operation = call.name === 'read_document' ? 'document read' : 'editor change';
  return waitUntil(run, call, {
    async check() {
      const { context, contextError } = await readContext(run, contextPayload);
      const current = activeEditorFileFromContext(context);
      if (!contextError && sameActiveEditorFile(expected, current)) return { ok: true, context };
      return { ok: false, current, contextError };
    },
    describe: ({ current, contextError }) => {
      const currentText = current
        ? `Currently open: ${current.relativePath}.`
        : contextError ? `The current file could not be checked (${contextError}).` : 'The current open file could not be identified.';
      return `Return to ${expected.relativePath} in the originating Typst tab. ${currentText} The ${operation} is paused until that file is open again.`;
    },
    missing: () => [`open file: ${expected.relativePath}`],
    timeoutCode: 'ACTIVE_FILE_PREFLIGHT_TIMEOUT',
    timeoutLabel: 'File-return wait timed out.'
  });
}

export async function waitForMessageFile(run, call) {
  if (!run.activeEditorFile) return { ok: true };
  const result = await waitForMessageFileContext(run, call, IDENTITY_PROBE);
  return result.ok ? { ok: true } : result;
}

export async function waitForVisibleFileStructure(run, call) {
  return waitUntil(run, call, {
    async check() {
      const { context, contextError } = await readContext(run, { projection: 'identity' });
      const projectTree = projectTreeFromContext(context);
      const filesPanelOpen = context?.workspace?.files_panel_open === true;
      if (!contextError && filesPanelOpen && projectTree) return { ok: true, projectTree };
      return { ok: false, filesPanelOpen, contextError };
    },
    describe: ({ filesPanelOpen, contextError }) => (contextError
      ? `Open the Files sidebar in the originating Typst tab. The page could not be checked (${contextError}).`
      : filesPanelOpen
        ? 'The Files sidebar is open, but its project entries could not be read yet. Keep it open and expand any folders whose children are needed.'
        : 'Open the Files sidebar in the originating Typst tab. Expand any folders whose children should be included; the scan will continue automatically.'),
    missing: () => ['open Files sidebar'],
    timeoutCode: 'FILE_STRUCTURE_PREFLIGHT_TIMEOUT',
    timeoutLabel: 'File-structure wait timed out.'
  });
}

export async function waitForRequestedProjectFile(run, call, requestedPath) {
  return waitUntil(run, call, {
    async check() {
      const { context, contextError } = await readContext(run, IDENTITY_PROBE);
      const current = activeEditorFileFromContext(context);
      if (!contextError && current?.relativePath === requestedPath) return { ok: true, context, activeFile: current };
      return { ok: false, current, contextError };
    },
    describe: ({ current, contextError }) => {
      const currentText = current
        ? current.relativePath === requestedPath
          ? `${requestedPath} is selected, but its editable text buffer is not ready (${contextError || 'editor unavailable'}).`
          : `Currently open: ${current.relativePath}.`
        : contextError
          ? `The current file could not be checked (${contextError}).`
          : 'The current open file could not be identified.';
      return `Open ${requestedPath} from the Files sidebar in the originating Typst tab. ${currentText} `
        + 'This call succeeds only after that exact path is available in the text editor.';
    },
    missing: () => [`open file: ${requestedPath}`],
    timeoutCode: 'PROJECT_FILE_PREFLIGHT_TIMEOUT',
    timeoutLabel: 'Project-file wait timed out.'
  });
}

function boundedArgumentSummary(args) {
  let text;
  try { text = JSON.stringify(args, null, 2); } catch { text = '{}'; }
  return {
    text: text.slice(0, 2000),
    characters: text.length,
    truncated: text.length > 2000
  };
}

/** Source-owned approval policy; model wording never changes it. */
export async function authorizeTool(run, call, route, args, preview = null, previewNotice = '') {
  const requiresPerEditReview = route.effect === 'editor-write' && preview?.kind === 'unified-diff';
  if (route.effect === 'read' && route.approval === 'automatic') return { ok: true };
  if (!requiresPerEditReview && route.approval === 'trusted') return { ok: true };
  if (!requiresPerEditReview && run.allowedTools.has(route.identity)) return { ok: true };
  const argumentSummary = boundedArgumentSummary(args);
  const payload = {
    callId: call.id,
    name: call.name,
    identity: route.identity,
    effect: route.effect || 'external',
    destination: route.destination || 'unknown destination',
    arguments: argumentSummary.text,
    argumentChars: argumentSummary.characters,
    argumentsTruncated: argumentSummary.truncated
  };
  if (preview) payload.preview = preview;
  if (typeof previewNotice === 'string' && previewNotice.trim()) payload.previewNotice = previewNotice.trim().slice(0, 500);
  emit(run, PROTOCOL.AI_TOOL_APPROVAL_REQUIRED, payload);
  const action = await waitForUserOrTimer(approvalWaiters, waiterKey(run.runId, call.id), APPROVAL_TIMEOUT_MS, run.signal, 'deny');
  if (action === 'allow_run') {
    if (!requiresPerEditReview) run.allowedTools.add(route.identity);
    return { ok: true };
  }
  if (action === 'approve_once') return { ok: true };
  return { ok: false, error: { code: 'TOOL_DENIED', message: 'User denied this side effect.' } };
}
