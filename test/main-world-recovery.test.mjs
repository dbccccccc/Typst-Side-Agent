import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(resolve(root, 'src/content/bridge-protocol.js'), 'utf8');
const isolatedSource = await readFile(resolve(root, 'src/content/isolated.js'), 'utf8');
const mainSource = await readFile(resolve(root, 'src/content/main.js'), 'utf8');

function pageContext(options = {}) {
  const listeners = new Map();
  const posts = [];
  let editorText = options.editorText ?? null;
  let activeFile = options.activeFile || null;
  let editorView = null;
  let editorElement = null;

  function makeDoc(text) {
    const starts = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
    const line = number => ({
      number,
      from: starts[number - 1],
      to: number < starts.length ? starts[number] - 1 : text.length,
      text: text.slice(starts[number - 1], number < starts.length ? starts[number] - 1 : text.length)
    });
    return {
      length: text.length,
      lines: starts.length,
      line,
      lineAt(position) {
        let number = 1;
        while (number < starts.length && starts[number] <= position) number += 1;
        return line(number);
      },
      toString() { return text; }
    };
  }

  function refreshEditorState() {
    if (!editorView) return;
    editorView.state = {
      doc: makeDoc(editorText),
      selection: { main: { head: 0, from: 0, to: 0 } },
      sliceDoc(from, to) { return editorText.slice(from, to); }
    };
  }

  if (editorText != null) {
    editorView = {
      state: null,
      dispatch({ changes }) {
        const list = Array.isArray(changes) ? [...changes] : [changes];
        for (const change of list.sort((left, right) => right.from - left.from)) {
          editorText = editorText.slice(0, change.from) + change.insert + editorText.slice(change.to);
        }
        refreshEditorState();
      }
    };
    refreshEditorState();
    editorElement = { cmView: { view: editorView, parent: null } };
  }
  const document = {
    body: {},
    hidden: false,
    readyState: 'complete',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector(selector) { return selector === '.cm-content' ? editorElement : null; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => 'uuid' },
    Date,
    Math,
    Node: { TEXT_NODE: 3 },
    document,
    innerWidth: 1200,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const items = listeners.get(type) || [];
      const index = items.indexOf(listener);
      if (index >= 0) items.splice(index, 1);
    },
    postMessage(message) { posts.push(message); }
  });
  if (activeFile) {
    context.__typstAgentWorkspaceExtract = () => ({ active_editor_file: activeFile });
  } else if (options.fileLabel) {
    context.__typstAgentWorkspaceExtract = () => ({ focused_element_file_hint: options.fileLabel });
  }
  context.window = context;
  document.defaultView = context;
  return {
    context, listeners, posts,
    getEditorText: () => editorText,
    setActiveFile(value) { activeFile = value; }
  };
}

test('main-world bootstrap does not poison its loaded flag when the bridge is absent', () => {
  const page = pageContext();
  vm.runInContext(mainSource, page.context, { filename: 'main.js' });
  assert.equal(page.context.__typstAgentMainLoaded, undefined);
  assert.equal(page.context.__typstAgentMainRuntime, undefined);
  assert.equal(page.listeners.get('message')?.length || 0, 0);
});

test('identity-only context reports the breadcrumb file without reading an editor document', () => {
  const activeFile = {
    projectLabel: 'Project', relativePath: 'references/ref.bib', basename: 'ref.bib',
    source: 'header_breadcrumb', confidence: 'high'
  };
  const page = pageContext({ activeFile });
  vm.runInContext(bridgeSource, page.context, { filename: 'bridge-protocol.js' });
  vm.runInContext(mainSource, page.context, { filename: 'main.js' });
  const bridge = page.context.__typstAgentBridgeProtocol;
  const windowObject = vm.runInContext('window', page.context);
  const deliver = message => page.listeners.get('message')[0]({ source: windowObject, data: message });

  deliver(bridge.envelope(bridge.TYPES.PAGE_BRIDGE_INIT, {}, { requestId: 'identity-init', nonce: 'identity-nonce' }));
  deliver(bridge.envelope(bridge.TYPES.PAGE_GET_CONTEXT, { projection: 'identity' }, { requestId: 'identity-read', nonce: 'identity-nonce' }));

  const response = page.posts.find(message => message.requestId === 'identity-read');
  assert.equal(response.payload.data.workspace.active_editor_file.relativePath, 'references/ref.bib');
  assert.equal(Object.hasOwn(response.payload.data, 'fullText'), false);
  assert.equal(Object.hasOwn(response.payload.data, 'numberedDocument'), false);
  assert.equal(Object.hasOwn(response.payload.data, 'editorToken'), false);
});

test('isolated bridge retries a transient MAIN load failure and preserves bundle order', async () => {
  const listeners = new Map();
  const timers = new Map();
  const appended = [];
  const removed = [];
  let failFirstLoad = true;
  let nextTimer = 1;
  const document = {
    documentElement: null,
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {
        async: true,
        dataset: {},
        remove() { removed.push(this.src); }
      };
    },
    head: {
      appendChild(script) {
        appended.push({ src: script.src, marker: script.dataset.typstSideAgentMainRecovery, async: script.async });
        queueMicrotask(() => {
          if (failFirstLoad) {
            failFirstLoad = false;
            script.onerror();
          } else {
            script.onload();
          }
        });
      }
    }
  };
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => 'isolated-uuid' },
    document,
    chrome: {
      runtime: {
        getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener() {} },
        sendMessage: async () => ({})
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    postMessage() {},
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.cleared = true;
    }
  });
  context.window = context;
  document.defaultView = context;

  vm.runInContext(bridgeSource, context, { filename: 'bridge-protocol.js' });
  vm.runInContext(isolatedSource, context, { filename: 'isolated.js' });
  const recoveryTimer = [...timers.values()].find(timer => timer.delay === 200);
  assert.ok(recoveryTimer);
  recoveryTimer.callback();
  for (let turn = 0; turn < 10 && ![...timers.values()].some(timer => timer.delay === 400); turn++) {
    await new Promise(resolve => { setImmediate(resolve); });
  }
  const retryTimer = [...timers.values()].find(timer => timer.delay === 400);
  assert.ok(retryTimer);
  retryTimer.callback();
  for (let turn = 0; turn < 10 && appended.length < 6; turn++) {
    await new Promise(resolve => { setImmediate(resolve); });
  }

  const expected = [
    'src/content/bridge-protocol.js',
    'src/content/workspace.js',
    'src/content/diagnostics.js',
    'src/content/float-controller.js',
    'src/content/main.js'
  ];
  assert.deepEqual(appended.map(item => item.src), [
    'chrome-extension://test/src/content/bridge-protocol.js',
    ...expected.map(path => `chrome-extension://test/${path}`)
  ]);
  assert.deepEqual(appended.map(item => item.marker), ['src/content/bridge-protocol.js', ...expected]);
  assert.ok(appended.every(item => item.async === false));
  assert.deepEqual(removed, appended.map(item => item.src));
});

test('isolated bridge cancels a queued edit before MAIN readiness', () => {
  const listeners = new Map();
  const posts = [];
  let runtimeListener = null;
  let nextTimer = 0;
  const timers = new Map();
  const document = {
    documentElement: null,
    createElement() { return { dataset: {}, remove() {} }; },
    head: { appendChild() {} }
  };
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => 'isolated-uuid' },
    document,
    chrome: {
      runtime: {
        getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener(listener) { runtimeListener = listener; } },
        sendMessage: async () => ({})
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    postMessage(message) { posts.push(message); },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  context.window = context;
  document.defaultView = context;
  vm.runInContext(bridgeSource, context, { filename: 'bridge-protocol.js' });
  vm.runInContext(isolatedSource, context, { filename: 'isolated.js' });
  const bridge = context.__typstAgentBridgeProtocol;
  let applyResponse = null;
  const apply = bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: 'old', expectedEditorToken: 'editor-1',
    expectedFileLabel: 'Current Typst document',
    changes: [{ from: 0, to: 3, insert: 'new' }], callId: 'call-1'
  }, { requestId: 'apply-1', runId: 'run-1' });
  assert.equal(runtimeListener(apply, {}, response => { applyResponse = response; }), true);

  let cancelResponse = null;
  const cancel = bridge.envelope(bridge.TYPES.PAGE_CANCEL_REQUEST, { targetRequestId: 'apply-1' }, { requestId: 'cancel-1', runId: 'run-1' });
  assert.equal(runtimeListener(cancel, {}, response => { cancelResponse = response; }), false);
  assert.equal(applyResponse.payload.ok, false);
  assert.equal(applyResponse.payload.error.code, 'CANCELLED');
  assert.equal(cancelResponse.payload.data.cancelled, true);

  const ready = bridge.envelope(bridge.TYPES.PAGE_BRIDGE_READY, {}, { requestId: 'ready-1', nonce: 'isolated-uuid' });
  for (const listener of listeners.get('message') || []) listener({ source: context, data: ready });
  assert.equal(posts.some(message => message.type === bridge.TYPES.PAGE_APPLY_EDIT), false);
});

test('main-world runtime accepts replacement nonces and remains idempotent', () => {
  const page = pageContext();
  vm.runInContext(bridgeSource, page.context, { filename: 'bridge-protocol.js' });
  vm.runInContext(mainSource, page.context, { filename: 'main.js' });
  assert.equal(page.context.__typstAgentMainLoaded, true);
  assert.equal(page.context.__typstAgentMainRuntime.version, 11);
  assert.equal(page.listeners.get('message').length, 1);

  const bridge = page.context.__typstAgentBridgeProtocol;
  const windowObject = vm.runInContext('window', page.context);
  const deliver = message => page.listeners.get('message')[0]({ source: windowObject, data: message });
  for (const suffix of ['old', 'new']) {
    deliver(bridge.envelope(bridge.TYPES.PAGE_BRIDGE_INIT, {}, {
      requestId: `init-${suffix}`,
      nonce: `nonce-${suffix}`
    }));
  }
  for (const suffix of ['old', 'new']) {
    deliver(bridge.envelope(bridge.TYPES.PAGE_GET_PROBE, {}, {
      requestId: `probe-${suffix}`,
      nonce: `nonce-${suffix}`
    }));
  }

  const ready = page.posts.filter(message => message.type === bridge.TYPES.PAGE_BRIDGE_READY);
  const responses = page.posts.filter(message => message.type === bridge.TYPES.RESPONSE);
  assert.deepEqual(ready.map(message => message.nonce), ['nonce-old', 'nonce-new']);
  assert.deepEqual(responses.map(message => message.nonce), ['nonce-old', 'nonce-new']);
  assert.ok(responses.every(message => message.payload.ok && message.payload.data.editor === false));

  vm.runInContext(mainSource, page.context, { filename: 'main-reinjected.js' });
  assert.equal(page.listeners.get('message').length, 1);
  page.context.__typstAgentMainRuntime.dispose();
  assert.equal(page.listeners.get('message').length, 0);
  assert.equal(page.context.__typstAgentMainLoaded, false);
});

test('reviewed edit commit is atomic and rejects stale document or file identity', () => {
  const page = pageContext({ editorText: '= Old', fileLabel: 'main.typ' });
  vm.runInContext(bridgeSource, page.context, { filename: 'bridge-protocol.js' });
  vm.runInContext(mainSource, page.context, { filename: 'main.js' });
  const bridge = page.context.__typstAgentBridgeProtocol;
  const windowObject = vm.runInContext('window', page.context);
  const deliver = message => page.listeners.get('message')[0]({ source: windowObject, data: message });
  deliver(bridge.envelope(bridge.TYPES.PAGE_BRIDGE_INIT, {}, { requestId: 'init', nonce: 'nonce' }));
  deliver(bridge.envelope(bridge.TYPES.PAGE_GET_CONTEXT, {}, { requestId: 'context', nonce: 'nonce' }));
  const contextResponse = page.posts.find(message => message.requestId === 'context');
  const editorToken = contextResponse.payload.data.editorToken;

  deliver(bridge.envelope(bridge.TYPES.PAGE_SHOW_EDIT_PREVIEW, {
    expectedText: '= Old',
    expectedEditorToken: editorToken,
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 5, insert: '= Fixed' }],
    callId: 'call-apply',
    preview: {
      kind: 'unified-diff', fileLabel: 'main.typ', additions: 1, deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
        { kind: 'delete', oldLine: 1, newLine: null, text: '= Old' },
        { kind: 'insert', oldLine: null, newLine: 1, text: '= Fixed' }
      ] }]
    }
  }, { requestId: 'show', runId: 'run', nonce: 'nonce' }));
  assert.equal(page.posts.find(message => message.requestId === 'show').payload.data.result.ok, true);

  deliver(bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: '= Different',
    expectedEditorToken: editorToken,
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 5, insert: '= Fixed' }],
    callId: 'call-stale'
  }, { requestId: 'stale', runId: 'run', nonce: 'nonce' }));
  assert.equal(page.posts.find(message => message.requestId === 'stale').payload.data.result.code, 'STALE_EDIT_PREVIEW');
  assert.equal(page.posts.find(message => message.requestId === 'stale').payload.data.result.staleReason, 'document');
  assert.equal(page.getEditorText(), '= Old');

  deliver(bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: '= Old',
    expectedEditorToken: 'another-editor',
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 5, insert: '= Wrong' }],
    callId: 'call-wrong-editor'
  }, { requestId: 'wrong-editor', runId: 'run', nonce: 'nonce' }));
  assert.equal(page.posts.find(message => message.requestId === 'wrong-editor').payload.data.result.code, 'STALE_EDIT_PREVIEW');
  assert.equal(page.posts.find(message => message.requestId === 'wrong-editor').payload.data.result.staleReason, 'editor');
  assert.equal(page.getEditorText(), '= Old');

  deliver(bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: '= Old',
    expectedEditorToken: editorToken,
    expectedFileLabel: 'other.typ',
    changes: [{ from: 0, to: 5, insert: '= Wrong file' }],
    callId: 'call-wrong-file'
  }, { requestId: 'wrong-file', runId: 'run', nonce: 'nonce' }));
  assert.equal(page.posts.find(message => message.requestId === 'wrong-file').payload.data.result.code, 'STALE_EDIT_PREVIEW');
  assert.equal(page.posts.find(message => message.requestId === 'wrong-file').payload.data.result.staleReason, 'file');
  assert.equal(page.getEditorText(), '= Old');

  deliver(bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: '= Old',
    expectedEditorToken: editorToken,
    expectedFileLabel: 'main.typ',
    changes: [{ from: 0, to: 5, insert: '= Fixed' }],
    callId: 'call-apply'
  }, { requestId: 'apply', runId: 'run', nonce: 'nonce' }));
  assert.equal(page.posts.find(message => message.requestId === 'apply').payload.data.result.reviewed_diff, true);
  assert.equal(page.getEditorText(), '= Fixed');

  deliver(bridge.envelope(bridge.TYPES.PAGE_CLEAR_EDIT_PREVIEW, {
    callId: 'call-apply'
  }, { requestId: 'clear', runId: 'run', nonce: 'nonce' }));
  assert.equal(page.posts.find(message => message.requestId === 'clear').payload.data.result.ok, true);
});

test('active breadcrumb path rejects a same-text bibliography edit after the user switches files', () => {
  const active = relativePath => ({
    projectLabel: 'Project', relativePath, basename: relativePath.split('/').at(-1),
    source: 'header_breadcrumb', confidence: 'high'
  });
  const page = pageContext({ editorText: '= Same', activeFile: active('references/ref.bib') });
  vm.runInContext(bridgeSource, page.context, { filename: 'bridge-protocol.js' });
  vm.runInContext(mainSource, page.context, { filename: 'main.js' });
  const bridge = page.context.__typstAgentBridgeProtocol;
  const windowObject = vm.runInContext('window', page.context);
  const deliver = message => page.listeners.get('message')[0]({ source: windowObject, data: message });
  deliver(bridge.envelope(bridge.TYPES.PAGE_BRIDGE_INIT, {}, { requestId: 'init-path', nonce: 'nonce-path' }));
  deliver(bridge.envelope(bridge.TYPES.PAGE_GET_CONTEXT, {}, { requestId: 'context-path', nonce: 'nonce-path' }));
  const editorToken = page.posts.find(message => message.requestId === 'context-path').payload.data.editorToken;

  page.setActiveFile(active('appendix/ref.bib'));
  deliver(bridge.envelope(bridge.TYPES.PAGE_APPLY_EDIT, {
    expectedText: '= Same',
    expectedEditorToken: editorToken,
    expectedFileLabel: 'references/ref.bib',
    changes: [{ from: 0, to: 6, insert: '= Wrong' }],
    callId: 'call-path-switch'
  }, { requestId: 'apply-path-switch', runId: 'run-path', nonce: 'nonce-path' }));

  assert.equal(page.posts.find(message => message.requestId === 'apply-path-switch').payload.data.result.code, 'STALE_EDIT_PREVIEW');
  assert.equal(page.posts.find(message => message.requestId === 'apply-path-switch').payload.data.result.staleReason, 'file');
  assert.equal(page.getEditorText(), '= Same');
});
