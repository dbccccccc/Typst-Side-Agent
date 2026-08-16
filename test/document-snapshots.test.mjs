import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteDocumentSnapshotForEditor, listDocumentSnapshotsForEditor,
  previewDocumentSnapshotRestore, restoreDocumentSnapshot
} from '../src/background/document-snapshots.js';
import { sha256Text } from '../src/shared/edit-checkpoint.js';
import { DOCUMENT_SNAPSHOT_KINDS } from '../src/shared/document-snapshot.js';
import { PROTOCOL } from '../src/shared/protocol.js';

async function storedSnapshot(overrides = {}) {
  const text = overrides.text ?? '= Saved';
  return {
    id: overrides.id || 'snapshot-one',
    kind: overrides.kind || DOCUMENT_SNAPSHOT_KINDS.MANUAL,
    projectId: overrides.projectId || 'project-a',
    fileLabel: overrides.fileLabel || 'main.typ',
    title: overrides.title || 'Manual snapshot',
    createdAt: overrides.createdAt || 100,
    text,
    textHash: await sha256Text(text),
    textLength: text.length,
    sessionId: overrides.sessionId ?? null,
    runId: overrides.runId ?? null,
    bodyKey: 'body',
    approxBytes: text.length
  };
}

function context(text = '= Current', fileLabel = 'main.typ') {
  return {
    fullText: text,
    editorToken: 'editor-one',
    workspace: { focused_element_file_hint: fileLabel }
  };
}

function payload(overrides = {}) {
  return {
    tabId: overrides.tabId ?? 7,
    projectId: overrides.projectId || 'project-a',
    sessionId: overrides.sessionId || 'chat-a',
    ...(overrides.snapshotId ? { snapshotId: overrides.snapshotId } : {})
  };
}

test('snapshot listing stays scoped to the complete live file and chat', async () => {
  const saved = await storedSnapshot({ text: '= Current', fileLabel: 'references/ref.bib' });
  const adapters = {
    tabsGet: async () => ({ url: 'https://typst.app/project/project-a' }),
    sendPageRequest: async (_tabId, type) => {
      assert.equal(type, PROTOCOL.PAGE_GET_CONTEXT);
      return {
        ...context(),
        workspace: { active_editor_file: {
          projectLabel: 'Project', relativePath: 'references/ref.bib', basename: 'ref.bib',
          source: 'header_breadcrumb', confidence: 'high'
        } }
      };
    },
    listDocumentSnapshots: async scope => {
      assert.deepEqual(scope, { projectId: 'project-a', fileLabel: 'references/ref.bib', sessionId: 'chat-a' });
      return [saved];
    }
  };

  const listed = await listDocumentSnapshotsForEditor(payload(), { adapters });
  assert.equal(listed.fileLabel, 'references/ref.bib');
  assert.deepEqual(listed.snapshots, [saved]);
});

test('snapshot restore previews current-to-saved diff, stores a rescue copy, and returns a context event', async () => {
  const snapshot = await storedSnapshot({ text: '= Saved' });
  let live = '= Current';
  const creates = [];
  const pageRequests = [];
  const adapters = {
    tabsGet: async () => ({ url: 'https://typst.app/project/project-a' }),
    loadDocumentSnapshot: async id => id === snapshot.id ? snapshot : null,
    createDocumentSnapshot: async input => {
      creates.push(structuredClone(input));
      const rescue = await storedSnapshot({ id: 'snapshot-rescue', kind: DOCUMENT_SNAPSHOT_KINDS.RESCUE, text: input.text, title: 'Before restore' });
      return { snapshot: rescue, deduplicated: false, promoted: false };
    },
    sendPageRequest: async (_tabId, type, requestPayload, options) => {
      pageRequests.push({ type, payload: structuredClone(requestPayload), options: structuredClone(options || {}) });
      if (type === PROTOCOL.PAGE_GET_CONTEXT) return context(live);
      if (type === PROTOCOL.PAGE_APPLY_EDIT) {
        assert.equal(requestPayload.expectedText, '= Current');
        assert.equal(requestPayload.expectedEditorToken, 'editor-one');
        assert.equal(requestPayload.expectedFileLabel, 'main.typ');
        assert.deepEqual(requestPayload.changes, [{ from: 0, to: '= Current'.length, insert: '= Saved' }]);
        assert.equal(requestPayload.reviewedDiff, false);
        live = '= Saved';
        return { result: { ok: true, edits_applied: 1 } };
      }
      throw new Error(`Unexpected page request ${type}`);
    },
    createId: () => 'restore-id',
    now: () => 500
  };

  const preview = await previewDocumentSnapshotRestore(payload({ snapshotId: snapshot.id }), { adapters });
  assert.equal(preview.noChanges, false);
  assert.equal(preview.preview.kind, 'unified-diff');
  assert.ok(preview.preview.additions > 0);
  assert.ok(preview.preview.deletions > 0);

  const restored = await restoreDocumentSnapshot(payload({ snapshotId: snapshot.id }), { adapters });
  assert.equal(live, '= Saved');
  assert.equal(restored.noChanges, false);
  assert.equal(restored.rescueSnapshot.id, 'snapshot-rescue');
  assert.deepEqual(creates, [{
    kind: DOCUMENT_SNAPSHOT_KINDS.RESCUE,
    projectId: 'project-a',
    fileLabel: 'main.typ',
    title: 'Before restore',
    text: '= Current',
    protectedSnapshotId: snapshot.id
  }]);
  assert.deepEqual(restored.editorStateUpdate, {
    kind: 'snapshot-restored',
    snapshotId: snapshot.id,
    fileLabel: 'main.typ',
    restoredAt: 500
  });
  assert.equal(pageRequests.at(-1).options.runId, 'snapshot-restore-restore-id');
});

test('snapshot operations reject active runs, mismatched files, and cross-project deletion', async () => {
  const snapshot = await storedSnapshot();
  const adapters = {
    tabsGet: async () => ({ url: 'https://typst.app/project/project-a' }),
    loadDocumentSnapshot: async () => snapshot,
    sendPageRequest: async () => context('= Current', 'other.typ'),
    deleteDocumentSnapshot: async () => ({ ok: true, removed: 1 })
  };
  await assert.rejects(
    previewDocumentSnapshotRestore(payload({ snapshotId: snapshot.id }), { adapters, activeRuns: [{ tabId: 7 }] }),
    error => error.code === 'DOCUMENT_SNAPSHOT_RUN_ACTIVE'
  );
  await assert.rejects(
    previewDocumentSnapshotRestore(payload({ snapshotId: snapshot.id }), { adapters }),
    error => error.code === 'DOCUMENT_SNAPSHOT_FILE_MISMATCH'
  );
  await assert.rejects(
    deleteDocumentSnapshotForEditor(payload({ snapshotId: snapshot.id, projectId: 'project-b' }), { adapters }),
    error => error.code === 'DOCUMENT_SNAPSHOT_PROJECT_MISMATCH'
  );
});
