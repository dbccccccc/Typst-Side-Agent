import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_REGISTRY, PROTOCOL, buildRequest, buildRunEvent, errorResponse,
  successResponse, unwrapResponse, validateEnvelope, validateMessagePayload, validateRunStartEnvelope
} from '../src/shared/protocol.js';

test('protocol registry has unique values and documents every constant', () => {
  assert.equal(new Set(Object.values(PROTOCOL)).size, Object.values(PROTOCOL).length);
  assert.equal(MESSAGE_REGISTRY.length, Object.values(PROTOCOL).length);
  assert.deepEqual(new Set(MESSAGE_REGISTRY.map(item => item.type)), new Set(Object.values(PROTOCOL)));
});

test('request/response envelope preserves correlation and structured errors', () => {
  const request = buildRequest(PROTOCOL.SESSION_LIST, { projectId: 'p' }, { requestId: 'req-1' });
  assert.deepEqual(request, { type: PROTOCOL.SESSION_LIST, requestId: 'req-1', payload: { projectId: 'p' } });
  assert.equal(validateEnvelope(request).ok, true);
  assert.deepEqual(unwrapResponse(successResponse('req-1', { value: 3 })), { value: 3 });
  assert.throws(() => unwrapResponse(errorResponse('req-1', { code: 'NOPE', message: 'Rejected', details: { field: 'x' } })), error => {
    assert.equal(error.code, 'NOPE');
    assert.deepEqual(error.details, { field: 'x' });
    return true;
  });
});

test('run messages require explicit immutable run identity', () => {
  assert.equal(validateEnvelope({ type: PROTOCOL.AI_STREAM_CANCEL, requestId: 'r', payload: {} }).error.code, 'INVALID_RUN_ID');
  const event = buildRunEvent(PROTOCOL.AI_STREAM_DONE, 'run-a', {});
  assert.equal(validateEnvelope(event).ok, true);
  assert.equal(event.runId, 'run-a');
});

test('run start rejects invalid tab, project, session, and messages', () => {
  const valid = buildRequest(PROTOCOL.AI_STREAM_START, {
    tabId: 4, projectId: 'project', sessionId: 'session', messages: [],
    activeEditorFile: {
      projectLabel: 'Project', relativePath: 'chapters/intro.typ', basename: 'intro.typ',
      source: 'header_breadcrumb', confidence: 'high'
    }
  }, { requestId: 'start', runId: 'run-a' });
  assert.equal(validateRunStartEnvelope(valid).ok, true);
  for (const [field, value, code] of [
    ['tabId', -1, 'INVALID_TAB_ID'],
    ['projectId', '', 'INVALID_PROJECT_ID'],
    ['sessionId', '', 'INVALID_SESSION_ID'],
    ['messages', {}, 'INVALID_MESSAGES']
  ]) {
    const broken = structuredClone(valid);
    broken.payload[field] = value;
    assert.equal(validateRunStartEnvelope(broken).error.code, code);
  }
  const badFile = structuredClone(valid);
  badFile.payload.activeEditorFile.relativePath = '../secret.typ';
  badFile.payload.activeEditorFile.basename = 'secret.typ';
  assert.equal(validateRunStartEnvelope(badFile).error.code, 'INVALID_ACTIVE_EDITOR_FILE');
  const injectedTree = structuredClone(valid);
  injectedTree.payload.projectTree = { source: 'files_panel_dom', entries: [], truncated: false };
  assert.equal(validateRunStartEnvelope(injectedTree).error.code, 'UNKNOWN_PAYLOAD_FIELD');
});

test('editor context supports an identity-only send-time projection', () => {
  const request = buildRequest(PROTOCOL.GET_EDITOR_CONTEXT, { tabId: 4, projection: 'identity' });
  assert.equal(validateEnvelope(request).ok, true);
  request.payload.projection = 'filename';
  assert.equal(validateEnvelope(request).error.code, 'INVALID_CONTEXT_PROJECTION');
});

test('unknown message types and malformed payloads fail closed', () => {
  assert.equal(validateEnvelope({ type: 'INVENTED', payload: {} }).error.code, 'UNKNOWN_MESSAGE_TYPE');
  assert.equal(validateEnvelope({ type: PROTOCOL.ACTIVE_TAB_CHANGED, payload: [] }).error.code, 'INVALID_PAYLOAD');
  assert.equal(validateMessagePayload(PROTOCOL.SESSION_LIST, {}).error.code, 'MISSING_PAYLOAD_FIELD');
  assert.equal(validateMessagePayload(PROTOCOL.SESSION_LIST, { projectId: 'p', surprise: true }).error.code, 'UNKNOWN_PAYLOAD_FIELD');
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.AI_TOOL_APPROVAL_RESOLVE, { callId: 'c', action: 'anything' }, { runId: 'run' })).error.code, 'INVALID_APPROVAL_ACTION');
  assert.equal(validateEnvelope({ type: PROTOCOL.RESPONSE, requestId: 'r', payload: { ok: false, error: 'nope' } }).error.code, 'INVALID_RESPONSE');
});

test('settings updates allow the send shortcut field but reject unknown fields', () => {
  const valid = buildRequest(PROTOCOL.SAVE_SETTINGS, {
    settings: { sendMessageShortcut: 'ctrl-enter' },
    fields: ['sendMessageShortcut']
  });
  assert.equal(validateEnvelope(valid).ok, true);

  const invalid = buildRequest(PROTOCOL.SAVE_SETTINGS, {
    settings: { invented: true },
    fields: ['invented']
  });
  assert.equal(validateEnvelope(invalid).error.code, 'INVALID_SETTINGS_FIELDS');
});

test('automatic session naming is a name-only guarded update', () => {
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.SESSION_UPDATE, {
    sessionId: 'session', name: 'Fresh title', autoName: true
  })).ok, true);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.SESSION_UPDATE, {
    sessionId: 'session', messages: [], autoName: true
  })).error.code, 'INVALID_SESSION_UPDATE');
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.SESSION_UPDATE, {
    sessionId: 'session', name: 'Fresh title', userRenamed: true, autoName: true
  })).error.code, 'INVALID_SESSION_UPDATE');
});

test('reviewed edit previews and atomic commits are structurally validated', () => {
  const preview = {
    kind: 'unified-diff',
    fileLabel: 'main.typ',
    additions: 1,
    deletions: 1,
    hunks: [{
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      rows: [
        { kind: 'delete', oldLine: 1, newLine: null, text: 'old' },
        { kind: 'insert', oldLine: null, newLine: 1, text: 'new' }
      ]
    }]
  };
  const approval = buildRunEvent(PROTOCOL.AI_TOOL_APPROVAL_REQUIRED, 'run-edit', {
    callId: 'call-edit',
    name: 'search_replace',
    identity: 'builtin:search_replace',
    effect: 'editor-write',
    destination: 'originating Typst editor',
    arguments: '{"search":"old","replace":"new"}',
    argumentChars: 32,
    argumentsTruncated: false,
    previewNotice: 'Inline preview is truncated.',
    preview
  });
  assert.equal(validateEnvelope(approval).ok, true);
  const invalidNotice = structuredClone(approval);
  invalidNotice.payload.previewNotice = 'x'.repeat(501);
  assert.equal(validateEnvelope(invalidNotice).error.code, 'INVALID_APPROVAL');
  const invalidSummary = structuredClone(approval);
  invalidSummary.payload.argumentsTruncated = true;
  assert.equal(validateEnvelope(invalidSummary).error.code, 'INVALID_APPROVAL');
  const invalidPreview = structuredClone(approval);
  invalidPreview.payload.preview.hunks[0].rows[0].kind = 'execute';
  assert.equal(validateEnvelope(invalidPreview).error.code, 'INVALID_EDIT_PREVIEW');

  const commit = buildRequest(PROTOCOL.PAGE_APPLY_EDIT, {
    expectedText: 'old',
    expectedEditorToken: 'editor-1',
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 3, insert: 'new' }],
    callId: 'call-edit'
  }, { runId: 'run-edit' });
  assert.equal(validateEnvelope(commit).ok, true);
  commit.payload.changes[0].to = -1;
  assert.equal(validateEnvelope(commit).error.code, 'INVALID_PREPARED_EDIT');

  const show = buildRequest(PROTOCOL.PAGE_SHOW_EDIT_PREVIEW, {
    expectedText: 'old',
    expectedEditorToken: 'editor-1',
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 3, insert: 'new' }],
    callId: 'call-edit',
    preview
  }, { runId: 'run-edit' });
  assert.equal(validateEnvelope(show).ok, true);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW, { callId: 'call-edit' }, { runId: 'run-edit' })).ok, true);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW, { callId: '' }, { runId: 'run-edit' })).error.code, 'INVALID_CALL_ID');
});

test('revert requests require an exact checkpoint, tab, project, and session scope', () => {
  const request = buildRequest(PROTOCOL.EDIT_CHECKPOINT_REVERT, {
    checkpointId: 'edit-123',
    tabId: 7,
    projectId: 'project-a',
    sessionId: 'session-a'
  });
  assert.equal(validateEnvelope(request).ok, true);
  assert.equal(Object.hasOwn(request, 'runId'), false);

  for (const [field, value, code] of [
    ['checkpointId', '', 'INVALID_CHECKPOINT_ID'],
    ['tabId', -1, 'INVALID_TAB_ID'],
    ['projectId', '', 'INVALID_PROJECT_ID'],
    ['sessionId', '', 'INVALID_SESSION_ID']
  ]) {
    const invalid = structuredClone(request);
    invalid.payload[field] = value;
    assert.equal(validateEnvelope(invalid).error.code, code);
  }
});

test('document snapshot requests require exact scope and completed runs may publish bounded metadata', () => {
  const scope = { tabId: 7, projectId: 'project-a', sessionId: 'session-a' };
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.DOCUMENT_SNAPSHOT_LIST, scope)).ok, true);
  for (const type of [PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW, PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE, PROTOCOL.DOCUMENT_SNAPSHOT_DELETE]) {
    assert.equal(validateEnvelope(buildRequest(type, { ...scope, snapshotId: 'snapshot-one' })).ok, true);
    assert.equal(validateEnvelope(buildRequest(type, { ...scope, snapshotId: '' })).error.code, 'INVALID_DOCUMENT_SNAPSHOT_ID');
  }
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.DOCUMENT_SNAPSHOT_LIST, { ...scope, tabId: -1 })).error.code, 'INVALID_DOCUMENT_SNAPSHOT_SCOPE');

  const snapshot = {
    id: 'snapshot-one',
    kind: 'automatic',
    projectId: 'project-a',
    fileLabel: 'main.typ',
    title: 'After latest response',
    createdAt: 100,
    textLength: 12,
    sessionId: 'session-a'
  };
  assert.equal(validateEnvelope(buildRunEvent(PROTOCOL.AI_STREAM_DONE, 'run-a', { snapshot })).ok, true);
  assert.equal(validateEnvelope(buildRunEvent(PROTOCOL.AI_STREAM_DONE, 'run-a', { snapshotWarning: 'Could not save it.' })).ok, true);
  assert.equal(validateEnvelope(buildRunEvent(PROTOCOL.AI_STREAM_DONE, 'run-a', { snapshotWarning: 'x'.repeat(501) })).error.code, 'INVALID_DOCUMENT_SNAPSHOT_WARNING');
});
