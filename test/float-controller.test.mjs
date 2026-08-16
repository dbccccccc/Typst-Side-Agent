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

test('main-world controller contains no continuous polling interval', async () => {
  const source = await readFile(new URL('../src/content/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.match(source, /__typstAgentCreateFloatController/);
  assert.match(source, /state\.doc !== preview\.expectedDoc/);
});
