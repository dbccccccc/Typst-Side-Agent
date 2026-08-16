import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamProviderRound } from '../src/background/provider.js';
import { deferred, sseResponse } from './helpers/fakes.mjs';

const base = {
  url: 'https://model.example/v1/chat/completions', apiKey: 'fixture-key', modelId: 'fixture-model',
  messages: [{ role: 'user', content: 'hello' }], tools: [], modelConfig: { reasoningEffort: 'default' }
};

test('provider parser handles arbitrary byte boundaries, reasoning, content, and tool-call accumulation', async () => {
  const deltas = [];
  let requestOptions;
  const response = await streamProviderRound({
    ...base,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n',
      'data: {"choices":[{"delta":{"content":"answer","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\"max_"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"document","arguments":"chars\\":10}"}}]}}]}\n',
      'data: [DO', 'NE]\n\n'
      ]);
    },
    onDelta: (channel, text) => deltas.push({ channel, text })
  });
  assert.equal(response.content, 'answer');
  assert.equal(response.reasoning, 'think ');
  assert.deepEqual(response.toolCalls, [{ id: 'call-1', name: 'read_document', rawArgs: '{"max_chars":10}' }]);
  assert.deepEqual(deltas, [{ channel: 'reasoning', text: 'think ' }, { channel: 'content', text: 'answer' }]);
  assert.equal(requestOptions.redirect, 'error');
});

test('provider rejects duplicate tool-call ids before returning a round', async () => {
  await assert.rejects(streamProviderRound({
    ...base,
    fetchImpl: async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'same-id', function: { name: 'read_document', arguments: '{}' } },
        { index: 1, id: 'same-id', function: { name: 'read_diagnostics', arguments: '{}' } }
      ] } }] })}\n`,
      'data: [DONE]\n\n'
    ])
  }), error => error.code === 'PROVIDER_DUPLICATE_TOOL_CALL_ID');
});

test('provider parser routes inline think blocks across chunks', async () => {
  const response = await streamProviderRound({
    ...base,
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"before<think>sec"}}]}\n',
      'data: {"choices":[{"delta":{"content":"ret</think>after"}}]}\n',
      'data: [DONE]\n\n'
    ])
  });
  assert.equal(response.content, 'beforeafter');
  assert.equal(response.reasoning, 'secret');
});

test('provider retains a split inline-think opener until the next delta', async () => {
  const response = await streamProviderRound({
    ...base,
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"before<thi"}}]}\n',
      'data: {"choices":[{"delta":{"content":"nk>secret</think>after"}}]}\n',
      'data: [DONE]\n\n'
    ])
  });
  assert.equal(response.content, 'beforeafter');
  assert.equal(response.reasoning, 'secret');
});

test('provider surfaces HTTP errors and excessive malformed SSE', async () => {
  await assert.rejects(streamProviderRound({
    ...base,
    fetchImpl: async () => new Response('provider rejected', { status: 503 })
  }), error => error.code === 'PROVIDER_HTTP_ERROR' && error.message.includes('503'));

  await assert.rejects(streamProviderRound({
    ...base,
    fetchImpl: async () => sseResponse(Array.from({ length: 17 }, () => 'data: not-json\n'))
  }), error => error.code === 'PROVIDER_MALFORMED_SSE');
});

test('provider cancellation interrupts a fetch adapter that ignores AbortSignal', async () => {
  const wait = deferred();
  const controller = new AbortController();
  const pending = streamProviderRound({ ...base, signal: controller.signal, fetchImpl: () => wait.promise });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
});

test('provider cancellation interrupts an HTTP error body read', async () => {
  const wait = deferred();
  const controller = new AbortController();
  const pending = streamProviderRound({
    ...base,
    signal: controller.signal,
    fetchImpl: async () => ({ ok: false, status: 503, text: () => wait.promise })
  });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
});

test('provider rejects malformed or oversized tool calls before dispatch', async () => {
  for (const delta of [
    { tool_calls: [{ index: 0, id: 7, function: { name: 'read_document', arguments: '{}' } }] },
    { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'bad tool name', arguments: '{}' } }] },
    { tool_calls: [{ index: 64, id: 'call-1', function: { name: 'read_document', arguments: '{}' } }] }
  ]) {
    await assert.rejects(streamProviderRound({
      ...base,
      fetchImpl: async () => sseResponse([`data: ${JSON.stringify({ choices: [{ delta }] })}\n`, 'data: [DONE]\n\n'])
    }), error => error.code === 'PROVIDER_INVALID_TOOL_CALL');
  }
});

test('provider cancels the network reader after parser failure and rejects declared oversized streams', async () => {
  let cancelled = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":{}}}]}\n'));
    },
    cancel() { cancelled += 1; }
  });
  await assert.rejects(streamProviderRound({
    ...base,
    fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  }), error => error.code === 'PROVIDER_INVALID_TOOL_CALL');
  assert.equal(cancelled, 1);

  await assert.rejects(streamProviderRound({
    ...base,
    fetchImpl: async () => new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'Content-Length': String(4 * 1024 * 1024 + 1) }
    })
  }), error => error.code === 'PROVIDER_STREAM_TOO_LARGE');
});
