import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranscriptEntry, createRunTranscript, isSameAssistantTurn, persistRunTranscriptToStorage, recordTranscriptEvent
} from '../src/background/agent/run-transcript.js';
import { configureStorageAdapter, resetStorageAdapter, sessionCreate, sessionGet, sessionUpdate } from '../src/background/storage.js';
import { PROTOCOL } from '../src/shared/protocol.js';
import { FakeStorage } from './helpers/fakes.mjs';

afterEach(() => resetStorageAdapter());

function recordedRun(runId, text) {
  const run = { runId, transcript: createRunTranscript() };
  recordTranscriptEvent(run, PROTOCOL.AI_STREAM_BATCH, { items: [{ channel: 'content', text }] });
  return run;
}

test('transcript entries carry the originating run id alongside bounded segments', () => {
  const run = recordedRun('run-a', 'hello');
  recordTranscriptEvent(run, PROTOCOL.AI_TOOL_CALLS, { calls: [{ id: 'call-1', name: 'read_document', args: {} }] });
  recordTranscriptEvent(run, PROTOCOL.AI_TOOL_RESULT, { callId: 'call-1', name: 'read_document', result: { ok: true } });
  const entry = buildTranscriptEntry(run, 'complete');
  assert.equal(entry.runId, 'run-a');
  assert.equal(entry.responseStatus, 'complete');
  assert.deepEqual(entry.segments.map(segment => segment.type), ['text', 'tools']);
  assert.deepEqual(entry.segments[1].results, { 'call-1': { ok: true } });
  assert.equal(buildTranscriptEntry({ runId: 'empty', transcript: createRunTranscript() }), null);
});

test('same-turn detection prefers run ids and falls back to content for legacy records', () => {
  const entry = { role: 'assistant', runId: 'run-a', content: 'x', toolCalls: [] };
  assert.equal(isSameAssistantTurn({ role: 'assistant', runId: 'run-a', content: 'different' }, entry), true);
  assert.equal(isSameAssistantTurn({ role: 'assistant', runId: 'run-b', content: 'x' }, entry), false);
  assert.equal(isSameAssistantTurn({ role: 'assistant', content: 'x', toolCalls: [] }, entry), true);
  assert.equal(isSameAssistantTurn({ role: 'assistant', content: 'y' }, entry), false);
  assert.equal(isSameAssistantTurn({ role: 'user', runId: 'run-a' }, entry), false);
});

test('the worker appends a turn the panel never saved and only updates status for a turn it did save', async () => {
  configureStorageAdapter(new FakeStorage());
  const session = await sessionCreate('project', 'Chat');
  const userTurn = { role: 'user', content: 'hello' };
  await sessionUpdate(session.id, { messages: [userTurn] });

  const entry = buildTranscriptEntry(recordedRun('run-a', 'answer'), 'complete');
  await persistRunTranscriptToStorage({ runId: 'run-a', sessionId: session.id, sourceMessages: [userTurn], entry });
  let stored = await sessionGet(session.id);
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[1].runId, 'run-a');
  assert.equal(stored.messages[1].responseStatus, 'complete');

  // The panel saved the same run with a stale status; the worker fixes only the status.
  await sessionUpdate(session.id, { messages: [userTurn, { ...stored.messages[1], content: 'panel copy', responseStatus: 'incomplete' }] });
  await persistRunTranscriptToStorage({ runId: 'run-a', sessionId: session.id, sourceMessages: [userTurn], entry });
  stored = await sessionGet(session.id);
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[1].content, 'panel copy');
  assert.equal(stored.messages[1].responseStatus, 'complete');

  // A different run is a new turn even when its text matches.
  const second = buildTranscriptEntry(recordedRun('run-b', 'answer'), 'complete');
  await persistRunTranscriptToStorage({ runId: 'run-b', sessionId: session.id, sourceMessages: stored.messages, entry: second });
  stored = await sessionGet(session.id);
  assert.deepEqual(stored.messages.map(message => message.runId ?? null), [null, 'run-a', 'run-b']);
});

test('persisting into a deleted session is a no-op', async () => {
  configureStorageAdapter(new FakeStorage());
  const entry = buildTranscriptEntry(recordedRun('run-a', 'answer'), 'complete');
  await persistRunTranscriptToStorage({ runId: 'run-a', sessionId: 'missing', sourceMessages: [], entry });
  assert.equal(await sessionGet('missing'), null);
});
