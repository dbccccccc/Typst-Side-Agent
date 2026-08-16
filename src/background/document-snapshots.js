import { TYPST_APP_PREFIX } from '../shared/constants.js';
import { sha256Text } from '../shared/edit-checkpoint.js';
import {
  DOCUMENT_SNAPSHOT_KINDS, createSnapshotRestoredEditorUpdate, publicDocumentSnapshot
} from '../shared/document-snapshot.js';
import { PROTOCOL, buildRequest, unwrapResponse } from '../shared/protocol.js';
import {
  createDocumentSnapshot, deleteDocumentSnapshot, listDocumentSnapshots, loadDocumentSnapshot
} from './storage.js';
import { buildUnifiedDiff, editorFileLabel } from './edit-preview.js';

function defaultAdapters() {
  return {
    tabsGet: tabId => chrome.tabs.get(tabId),
    sendPageRequest: async (tabId, type, payload, options = {}) => {
      const response = await chrome.tabs.sendMessage(tabId, buildRequest(type, payload, options));
      return unwrapResponse(response);
    },
    createDocumentSnapshot,
    deleteDocumentSnapshot,
    listDocumentSnapshots,
    loadDocumentSnapshot,
    sha256Text,
    buildUnifiedDiff,
    createId: () => crypto.randomUUID(),
    now: () => Date.now()
  };
}

export async function listDocumentSnapshotsForEditor(payload, options = {}) {
  const adapters = { ...defaultAdapters(), ...(options.adapters || {}) };
  await assertTabScope(adapters, payload.tabId, payload.projectId);
  const context = await readEditContext(adapters, payload.tabId);
  const fileLabel = editorFileLabel(context.workspace);
  const snapshots = await adapters.listDocumentSnapshots({
    projectId: payload.projectId,
    fileLabel,
    sessionId: payload.sessionId
  });
  return { ok: true, fileLabel, snapshots };
}

export async function previewDocumentSnapshotRestore(payload, options = {}) {
  const adapters = { ...defaultAdapters(), ...(options.adapters || {}) };
  assertNoActiveRun(payload.tabId, options.activeRuns);
  await assertTabScope(adapters, payload.tabId, payload.projectId);
  const [snapshot, context] = await Promise.all([
    loadScopedSnapshot(adapters, payload),
    readEditContext(adapters, payload.tabId)
  ]);
  assertFocusedFile(snapshot, context);
  await assertSnapshotIntegrity(adapters, snapshot);
  if (snapshot.text === context.fullText) {
    return { ok: true, snapshot: publicDocumentSnapshot(snapshot), noChanges: true, preview: null };
  }
  const preview = adapters.buildUnifiedDiff(context.fullText, snapshot.text);
  return {
    ok: true,
    snapshot: publicDocumentSnapshot(snapshot),
    noChanges: false,
    preview: preview.ok ? {
      kind: 'unified-diff',
      fileLabel: snapshot.fileLabel,
      additions: preview.additions,
      deletions: preview.deletions,
      hunks: preview.hunks
    } : null,
    ...(preview.ok ? {} : { previewNotice: preview.error || 'The complete restore diff is too large to display.' })
  };
}

export async function restoreDocumentSnapshot(payload, options = {}) {
  const adapters = { ...defaultAdapters(), ...(options.adapters || {}) };
  assertNoActiveRun(payload.tabId, options.activeRuns);
  await assertTabScope(adapters, payload.tabId, payload.projectId);
  const snapshot = await loadScopedSnapshot(adapters, payload);
  await assertSnapshotIntegrity(adapters, snapshot);
  const context = await readEditContext(adapters, payload.tabId);
  assertFocusedFile(snapshot, context);
  if (snapshot.text === context.fullText) {
    return { ok: true, snapshot: publicDocumentSnapshot(snapshot), noChanges: true, rescueSnapshot: null, editorStateUpdate: null };
  }

  // A restore is never the only path back: save the live source first and
  // refuse to overwrite if that rescue copy cannot be committed locally.
  const rescue = await adapters.createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.RESCUE,
    projectId: payload.projectId,
    fileLabel: snapshot.fileLabel,
    title: 'Before restore',
    text: context.fullText,
    protectedSnapshotId: snapshot.id
  });

  await assertTabScope(adapters, payload.tabId, payload.projectId);
  const runId = `snapshot-restore-${adapters.createId()}`;
  const response = await adapters.sendPageRequest(payload.tabId, PROTOCOL.PAGE_APPLY_EDIT, {
    expectedText: context.fullText,
    expectedEditorToken: context.editorToken,
    expectedFileLabel: snapshot.fileLabel,
    changes: [{ from: 0, to: context.fullText.length, insert: snapshot.text }],
    callId: `restore-${snapshot.id}`
  }, { runId });
  const result = response?.result || response;
  if (result?.ok !== true) {
    throw coded(result?.code || 'DOCUMENT_SNAPSHOT_RESTORE_FAILED', result?.error || 'The Typst editor rejected the snapshot restore transaction.');
  }

  return {
    ok: true,
    snapshot: publicDocumentSnapshot(snapshot),
    noChanges: false,
    rescueSnapshot: rescue?.snapshot || null,
    editorStateUpdate: createSnapshotRestoredEditorUpdate(snapshot, adapters.now())
  };
}

export async function deleteDocumentSnapshotForEditor(payload, options = {}) {
  const adapters = { ...defaultAdapters(), ...(options.adapters || {}) };
  assertNoActiveRun(payload.tabId, options.activeRuns);
  await assertTabScope(adapters, payload.tabId, payload.projectId);
  const [snapshot, context] = await Promise.all([
    loadScopedSnapshot(adapters, payload),
    readEditContext(adapters, payload.tabId)
  ]);
  assertFocusedFile(snapshot, context);
  const result = await adapters.deleteDocumentSnapshot({ id: snapshot.id, projectId: payload.projectId });
  return { ok: true, ...result };
}

async function loadScopedSnapshot(adapters, payload) {
  const snapshot = await adapters.loadDocumentSnapshot(payload.snapshotId);
  if (!snapshot) throw coded('DOCUMENT_SNAPSHOT_NOT_FOUND', 'This document snapshot has expired or is no longer available.');
  if (snapshot.projectId !== payload.projectId) throw coded('DOCUMENT_SNAPSHOT_SCOPE_MISMATCH', 'This snapshot belongs to a different Typst project.');
  if (snapshot.kind === DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC && snapshot.sessionId !== payload.sessionId) {
    throw coded('DOCUMENT_SNAPSHOT_SCOPE_MISMATCH', 'This automatic snapshot belongs to a different chat.');
  }
  return snapshot;
}

async function assertSnapshotIntegrity(adapters, snapshot) {
  if (typeof snapshot.text !== 'string') throw coded('DOCUMENT_SNAPSHOT_BODY_MISSING', 'The saved document source is unavailable.');
  const hash = await adapters.sha256Text(snapshot.text);
  if (hash !== snapshot.textHash || snapshot.text.length !== snapshot.textLength) {
    throw coded('DOCUMENT_SNAPSHOT_BODY_INVALID', 'The saved document snapshot failed its integrity check.');
  }
}

async function readEditContext(adapters, tabId) {
  const context = await adapters.sendPageRequest(tabId, PROTOCOL.PAGE_GET_CONTEXT, { projection: 'edit' });
  if (!context || typeof context.fullText !== 'string' || typeof context.editorToken !== 'string' || !context.editorToken) {
    throw coded('DOCUMENT_SNAPSHOT_CONTEXT_UNAVAILABLE', context?.error || 'The live Typst editor could not be read.');
  }
  return context;
}

function assertFocusedFile(snapshot, context) {
  if (editorFileLabel(context.workspace) !== snapshot.fileLabel) {
    throw coded('DOCUMENT_SNAPSHOT_FILE_MISMATCH', `Open ${snapshot.fileLabel} before restoring this snapshot.`);
  }
}

async function assertTabScope(adapters, tabId, projectId) {
  const tab = await adapters.tabsGet(tabId);
  if (!tab?.url?.startsWith(TYPST_APP_PREFIX)) throw coded('NOT_TYPST_TAB', 'The selected tab is no longer a typst.app page.');
  const match = tab.url.match(/typst\.app\/project\/([^/?#]+)/);
  if (!match || match[1] !== projectId) throw coded('DOCUMENT_SNAPSHOT_PROJECT_MISMATCH', 'The selected tab no longer shows the project that owns this snapshot.');
}

function assertNoActiveRun(tabId, activeRuns = []) {
  if ((activeRuns || []).some(run => run.tabId === tabId)) {
    throw coded('DOCUMENT_SNAPSHOT_RUN_ACTIVE', 'Wait for the active agent run on this tab to finish before changing document snapshots.');
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
