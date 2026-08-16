import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadBridge() {
  const source = await readFile(resolve(root, 'src/content/bridge-protocol.js'), 'utf8');
  const context = vm.createContext({
    crypto: { randomUUID: () => 'uuid' },
    Date,
    Math
  });
  vm.runInContext(source, context, { filename: 'bridge-protocol.js' });
  return context.__typstAgentBridgeProtocol;
}

test('page bridge requires correlation and run identity at its trust boundary', async () => {
  const bridge = await loadBridge();
  const contextRequest = bridge.envelope(bridge.TYPES.PAGE_GET_CONTEXT, {}, { requestId: 'request-1' });
  assert.equal(bridge.valid(contextRequest), true);
  assert.equal(bridge.valid(bridge.envelope(bridge.TYPES.PAGE_GET_CONTEXT, { projection: 'identity' }, { requestId: 'request-identity' })), true);
  assert.equal(bridge.valid(bridge.envelope(bridge.TYPES.PAGE_GET_CONTEXT, { projection: 'filename' }, { requestId: 'request-invalid-projection' })), false);
  assert.equal(bridge.valid({ ...contextRequest, requestId: '' }), false);
  assert.equal(bridge.valid({ type: bridge.TYPES.PAGE_GET_CONTEXT, payload: {} }), false);

  const applyRequest = bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: 'old',
    expectedEditorToken: 'editor-1',
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 3, insert: 'new' }],
    callId: 'call-2',
    reviewedDiff: true
  }, { requestId: 'request-2', runId: 'run-1' });
  assert.equal(bridge.valid(applyRequest), true);
  assert.equal(bridge.valid({ ...applyRequest, runId: '' }), false);
  assert.equal(bridge.valid({ ...applyRequest, payload: { ...applyRequest.payload, changes: [{ from: 3, to: 1, insert: '' }] } }), false);

  const showRequest = bridge.envelope(bridge.TYPES.PAGE_SHOW_EDIT_PREVIEW, {
    expectedText: 'old',
    expectedEditorToken: 'editor-1',
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 3, insert: 'new' }],
    callId: 'call-2',
    preview: {
      kind: 'unified-diff', fileLabel: 'main.typ', additions: 1, deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
        { kind: 'delete', oldLine: 1, newLine: null, text: 'old' },
        { kind: 'insert', oldLine: null, newLine: 1, text: 'new' }
      ] }]
    }
  }, { requestId: 'request-3', runId: 'run-1' });
  assert.equal(bridge.valid(showRequest), true);
  const clearRequest = bridge.envelope(bridge.TYPES.PAGE_CLEAR_EDIT_PREVIEW, { callId: 'call-2' }, { requestId: 'request-4', runId: 'run-1' });
  assert.equal(bridge.valid(clearRequest), true);
  assert.equal(bridge.valid({ ...clearRequest, payload: { callId: 'call-2', surprise: true } }), false);

  const cancelRequest = bridge.envelope(bridge.TYPES.PAGE_CANCEL_REQUEST, { targetRequestId: 'request-2' }, { requestId: 'cancel-1', runId: 'run-1' });
  assert.equal(bridge.valid(cancelRequest), true);
  assert.equal(bridge.valid({ ...cancelRequest, payload: { targetRequestId: '' } }), false);
});

test('page bridge validates response shapes and bounds for the originating request', async () => {
  const bridge = await loadBridge();
  const response = (data, requestId = 'response-1') => bridge.envelope(bridge.TYPES.RESPONSE, { ok: true, data }, { requestId });
  assert.equal(bridge.validResponse(response({
    dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1, mimeType: 'image/png'
  }), bridge.TYPES.PAGE_GET_PREVIEW), true);
  assert.equal(bridge.validResponse(response({
    dataUrl: 'https://remote.example/image.png', width: 1, height: 1
  }), bridge.TYPES.PAGE_GET_PREVIEW), false);
  assert.equal(bridge.validResponse(response({ diagnostics: [], totalCount: 0, truncated: false }), bridge.TYPES.PAGE_GET_DIAGNOSTICS), true);
  assert.equal(bridge.validResponse(response({ diagnostics: Array.from({ length: 201 }, () => ({ message: 'x' })) }), bridge.TYPES.PAGE_GET_DIAGNOSTICS), false);
});
