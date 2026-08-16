import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestCompletedResponseIndex, latestEditCheckpoint, updateEditCheckpointInHistory
} from '../src/sidepanel/chat.js';

function toolSegment(name, id, checkpoint) {
  return {
    type: 'tools',
    calls: [{ id, name, args: {} }],
    results: { [id]: { ok: true, editCheckpoint: checkpoint } }
  };
}

test('assistant responses expose the latest built-in editor checkpoint only', () => {
  const message = {
    role: 'assistant',
    content: 'done',
    segments: [
      toolSegment('search_replace', 'first', { id: 'edit-one', status: 'applied', fileLabel: 'one.typ', createdAt: 1 }),
      toolSegment('external_tool', 'spoofed', { id: 'edit-spoofed', status: 'applied', fileLabel: 'bad.typ', createdAt: 2 }),
      toolSegment('patch_document', 'second', { id: 'edit-two', status: 'applied', fileLabel: 'main.typ', createdAt: 3 })
    ]
  };
  assert.deepEqual(latestEditCheckpoint(message), {
    id: 'edit-two', status: 'applied', fileLabel: 'main.typ', createdAt: 3
  });
});

test('imported checkpoint receipts remain visible but explicitly unavailable', () => {
  const message = {
    role: 'assistant',
    content: 'done',
    segments: [toolSegment('replace_lines', 'call', {
      id: 'edit-imported',
      status: 'unavailable',
      fileLabel: 'main.typ',
      createdAt: 4,
      unavailableReason: 'Revert data is not included in session exports.'
    })]
  };
  const checkpoint = latestEditCheckpoint(message);
  assert.equal(checkpoint.status, 'unavailable');
  assert.match(checkpoint.unavailableReason, /not included/i);
  assert.equal(latestEditCheckpoint({ segments: [toolSegment('external_tool', 'call', checkpoint)] }), null);
});

test('cascade summaries update every matching response receipt in history', () => {
  const history = [
    { role: 'assistant', content: 'first', segments: [toolSegment('search_replace', 'first', {
      id: 'edit-first', status: 'applied', fileLabel: 'main.typ', createdAt: 1
    })] },
    { role: 'assistant', content: 'second', segments: [toolSegment('patch_document', 'second', {
      id: 'edit-second', status: 'applied', fileLabel: 'main.typ', createdAt: 2
    })] }
  ];

  assert.equal(updateEditCheckpointInHistory(history, {
    id: 'edit-second', status: 'reverted', fileLabel: 'main.typ', createdAt: 2
  }), 1);
  assert.equal(updateEditCheckpointInHistory(history, {
    id: 'edit-first', status: 'reverted', fileLabel: 'main.typ', createdAt: 1
  }), 1);
  assert.deepEqual(history.map(latestEditCheckpoint).map(checkpoint => checkpoint.status), ['reverted', 'reverted']);
});

test('snapshot actions attach only to the latest successfully completed assistant response', () => {
  const history = [
    { role: 'assistant', content: 'first', responseStatus: 'complete' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'partial', responseStatus: 'incomplete' }
  ];
  assert.equal(latestCompletedResponseIndex(history), 0);
  history.push({ role: 'assistant', content: 'latest', responseStatus: 'complete' });
  assert.equal(latestCompletedResponseIndex(history), 3);
  assert.equal(latestCompletedResponseIndex([{ role: 'assistant', content: 'legacy' }]), -1);
});
