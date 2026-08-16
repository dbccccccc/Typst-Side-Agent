import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../src/content/float-controller.js');

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.body = {};
    this.documentElement = {};
  }
  querySelector() { return null; }
}

test('float controller coalesces relevant events into animation-frame invalidations', () => {
  const document = new FakeDocument();
  const window = new EventTarget();
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const frames = [];
  const flushed = [];
  const controller = globalThis.__typstAgentCreateFloatController({
    document,
    window,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    onFlush: flags => flushed.push([...flags].sort())
  });
  assert.equal(frames.length, 1, 'initial state schedules one frame');
  document.dispatchEvent(new Event('selectionchange'));
  document.dispatchEvent(new Event('pointerup'));
  assert.equal(frames.length, 1, 'events coalesce before the frame');
  frames.shift()();
  assert.ok(flushed[0].includes('selection'));
  assert.ok(flushed[0].includes('preview'));
  window.dispatchEvent(new Event('resize'));
  frames.shift()();
  assert.deepEqual(flushed[1], ['layout']);
  controller.stop();
  document.dispatchEvent(new Event('selectionchange'));
  assert.equal(frames.length, 0);
});

test('editor input does not invalidate broad preview or workspace scans', async () => {
  const document = new FakeDocument();
  const window = new EventTarget();
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const frames = [];
  const flushed = [];
  const controller = globalThis.__typstAgentCreateFloatController({
    document,
    window,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    onFlush: flags => flushed.push([...flags].sort())
  });
  frames.shift()();
  flushed.length = 0;
  document.dispatchEvent(new Event('input'));
  await new Promise(resolve => { setTimeout(resolve, 60); });
  frames.shift()();
  assert.deepEqual(flushed, [['layout', 'selection']]);
  controller.stop();
});

test('surface observers ignore CodeMirror mutations and scope preview and Files invalidations', async () => {
  const makeNode = (kind, parent = null) => ({
    kind,
    parent,
    closest(selector) {
      for (let current = this; current; current = current.parent) {
        if (selector.includes('.cm-editor') && current.kind === 'editor') return current;
        if (selector.includes('Files') && current.kind === 'files') return current;
      }
      return null;
    },
    matches(selector) {
      return (this.kind === 'preview' && /canvas|preview/.test(selector))
        || (this.kind === 'files' && /Files|tree/.test(selector));
    },
    querySelector() { return null; }
  });
  const document = new FakeDocument();
  const window = new EventTarget();
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const shell = makeNode('shell');
  const editor = makeNode('editor', shell);
  const editorChild = makeNode('editor-child', editor);
  const files = makeNode('files', shell);
  const preview = makeNode('preview', shell);
  document.body = shell;
  const frames = [];
  const flushed = [];
  const instances = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; instances.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() {}
  }
  const controller = globalThis.__typstAgentCreateFloatController({
    document,
    window,
    filesRoot: files,
    previewRoots: [preview],
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    MutationObserver: Observer,
    onFlush: flags => flushed.push([...flags].sort())
  });
  frames.shift()();
  flushed.length = 0;
  const rootObserver = instances.find(instance => instance.targets.includes(shell));
  const filesObserver = instances.find(instance => instance.targets.includes(files));
  const previewObserver = instances.find(instance => instance.targets.includes(preview));
  assert.ok(rootObserver && filesObserver && previewObserver);

  rootObserver.callback([{ target: editor, addedNodes: [editorChild], removedNodes: [] }]);
  await new Promise(resolve => { setTimeout(resolve, 60); });
  assert.equal(frames.length, 0);

  filesObserver.callback([{ target: files, addedNodes: [], removedNodes: [] }]);
  await new Promise(resolve => { setTimeout(resolve, 60); });
  frames.shift()();
  assert.deepEqual(flushed.shift(), ['workspace']);

  previewObserver.callback([{ target: preview, addedNodes: [], removedNodes: [] }]);
  await new Promise(resolve => { setTimeout(resolve, 60); });
  frames.shift()();
  assert.deepEqual(flushed.shift(), ['preview']);

  rootObserver.callback([{ target: shell, addedNodes: [makeNode('preview', shell)], removedNodes: [] }]);
  await new Promise(resolve => { setTimeout(resolve, 60); });
  frames.shift()();
  assert.deepEqual(flushed.shift(), ['layout', 'preview', 'workspace']);
  controller.stop();
});

test('main-world controller contains no continuous polling interval', async () => {
  const source = await readFile(new URL('../src/content/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.match(source, /__typstAgentCreateFloatController/);
  assert.match(source, /state\.doc !== preview\.expectedDoc/);
});
