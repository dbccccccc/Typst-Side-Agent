import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResponseTextBounded } from '../src/shared/bounded-response.js';

test('bounded response reader cancels chunked bodies as soon as the limit is crossed', async () => {
  const encoder = new TextEncoder();
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('abc'));
      controller.enqueue(encoder.encode('def'));
    },
    cancel() { cancelled += 1; }
  });
  const response = new Response(body);
  await assert.rejects(
    readResponseTextBounded(response, { maxBytes: 5, errorCode: 'TOO_LARGE', errorMessage: 'too large' }),
    error => error.code === 'TOO_LARGE'
  );
  assert.equal(cancelled, 1);
});

test('bounded response reader rejects an excessive Content-Length before reading', async () => {
  let reads = 0;
  const response = {
    headers: { get: name => name === 'Content-Length' ? '6' : null },
    body: { getReader: () => ({ read: async () => { reads += 1; return { done: true }; } }) }
  };
  await assert.rejects(readResponseTextBounded(response, { maxBytes: 5 }), error => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(reads, 0);
});
