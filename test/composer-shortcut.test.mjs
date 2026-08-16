import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMessageShortcutLabel, shouldSendMessageForKey
} from '../src/sidepanel/composer-shortcut.js';

function enterEvent(modifiers = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...modifiers
  };
}

test('only the configured Enter shortcut sends and the other two remain newline chords', () => {
  const plainEnter = enterEvent();
  const shiftEnter = enterEvent({ shiftKey: true });
  const ctrlEnter = enterEvent({ ctrlKey: true });

  assert.deepEqual([
    shouldSendMessageForKey(plainEnter, 'enter'),
    shouldSendMessageForKey(shiftEnter, 'enter'),
    shouldSendMessageForKey(ctrlEnter, 'enter')
  ], [true, false, false]);
  assert.deepEqual([
    shouldSendMessageForKey(plainEnter, 'shift-enter'),
    shouldSendMessageForKey(shiftEnter, 'shift-enter'),
    shouldSendMessageForKey(ctrlEnter, 'shift-enter')
  ], [false, true, false]);
  assert.deepEqual([
    shouldSendMessageForKey(plainEnter, 'ctrl-enter'),
    shouldSendMessageForKey(shiftEnter, 'ctrl-enter'),
    shouldSendMessageForKey(ctrlEnter, 'ctrl-enter')
  ], [false, false, true]);

  assert.equal(shouldSendMessageForKey(plainEnter, 'unknown'), true);
  assert.equal(shouldSendMessageForKey(enterEvent({ shiftKey: true, ctrlKey: true }), 'ctrl-enter'), false);
  assert.equal(shouldSendMessageForKey(enterEvent({ isComposing: true }), 'enter'), false);
  assert.equal(shouldSendMessageForKey(enterEvent({ altKey: true }), 'enter'), false);
  assert.equal(shouldSendMessageForKey(enterEvent({ metaKey: true }), 'enter'), false);
  assert.equal(shouldSendMessageForKey({ ...plainEnter, key: 'a' }, 'enter'), false);

  assert.equal(sendMessageShortcutLabel('enter'), 'Enter');
  assert.equal(sendMessageShortcutLabel('shift-enter'), 'Shift + Enter');
  assert.equal(sendMessageShortcutLabel('ctrl-enter'), 'Ctrl + Enter');
});
