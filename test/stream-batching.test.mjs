import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamBatcher } from '../src/background/stream-batcher.js';

test('stream batcher merges only adjacent channels and preserves exact order', () => {
  const emitted = [];
  const timers = [];
  const batcher = createStreamBatcher({
    runId: 'run-a', emit: event => emitted.push(event),
    setTimer: callback => { timers.push(callback); return timers.length; },
    clearTimer: () => {}
  });
  batcher.push('reasoning', 'a');
  batcher.push('reasoning', 'b');
  batcher.push('content', 'c');
  batcher.push('reasoning', 'd');
  batcher.flush();
  assert.deepEqual(emitted, [{ runId: 'run-a', items: [
    { channel: 'reasoning', text: 'ab' },
    { channel: 'content', text: 'c' },
    { channel: 'reasoning', text: 'd' }
  ] }]);
});

test('thousands of deltas emit one bounded batch before a boundary flush', () => {
  const emitted = [];
  const batcher = createStreamBatcher({ runId: 'r', emit: event => emitted.push(event), setTimer: () => 1, clearTimer: () => {} });
  for (let i = 0; i < 5000; i++) batcher.push('content', 'x');
  assert.equal(emitted.length, 0);
  batcher.flush();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].items[0].text.length, 5000);
});

test('cancel prevents queued or later output', () => {
  const emitted = [];
  const batcher = createStreamBatcher({ runId: 'r', emit: event => emitted.push(event), setTimer: () => 1, clearTimer: () => {} });
  batcher.push('content', 'before');
  batcher.cancel();
  batcher.flush();
  batcher.push('content', 'after');
  assert.deepEqual(emitted, []);
});
