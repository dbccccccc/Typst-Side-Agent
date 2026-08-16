import { isReasoningEffortDefault, LIMITS } from '../shared/constants.js';
import { raceWithSignal, throwIfAborted } from '../shared/abort.js';
import { readResponseTextBounded } from '../shared/bounded-response.js';

const MAX_TOOL_CALLS = 64;
const MAX_TOOL_CALL_ID_CHARS = 128;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_ARGUMENT_CHARS = 256_000;

/** Pull reasoning text out of the common OpenAI-compatible delta dialects. */
export function extractReasoningChunk(delta) {
  if (!delta) return '';
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (delta.reasoning && typeof delta.reasoning.content === 'string') return delta.reasoning.content;
  if (typeof delta.thinking === 'string') return delta.thinking;
  return '';
}

/** Split complete `<think>…</think>` blocks while retaining an incomplete tail. */
export function splitInlineThink(buffer) {
  const out = { reasoning: '', content: '', remainder: '' };
  let offset = 0;
  while (offset < buffer.length) {
    const open = buffer.indexOf('<think>', offset);
    if (open < 0) {
      const tail = trailingPrefixLength(buffer.slice(offset), '<think>');
      out.content += buffer.slice(offset, buffer.length - tail);
      out.remainder = tail ? buffer.slice(buffer.length - tail) : '';
      break;
    }
    out.content += buffer.slice(offset, open);
    const close = buffer.indexOf('</think>', open + 7);
    if (close < 0) { out.remainder = buffer.slice(open); break; }
    out.reasoning += buffer.slice(open + 7, close);
    offset = close + 8;
  }
  return out;
}

function trailingPrefixLength(value, token) {
  const max = Math.min(value.length, token.length - 1);
  for (let length = max; length > 0; length--) {
    if (value.endsWith(token.slice(0, length))) return length;
  }
  return 0;
}

export async function streamProviderRound({
  url,
  apiKey,
  modelId,
  messages,
  tools,
  signal,
  modelConfig,
  fetchImpl = (...args) => fetch(...args),
  onDelta = () => {}
}) {
  const body = { model: modelId, stream: true, messages, tools };
  const effort = String(modelConfig?.reasoningEffort || '').trim();
  if (effort && !isReasoningEffortDefault(effort)) body.reasoning_effort = effort;

  const response = await raceWithSignal(fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  }), signal);
  if (!response.ok) {
    const text = await readResponseTextBounded(response, {
      maxBytes: LIMITS.MAX_PROVIDER_ERROR_BYTES,
      signal,
      errorCode: 'PROVIDER_ERROR_RESPONSE_TOO_LARGE',
      errorMessage: 'Provider error response exceeds the 64 KiB limit.'
    }).catch(error => {
      if (error.code === 'CANCELLED') throw error;
      return '';
    });
    const error = new Error(`API ${response.status}: ${text.slice(0, 300)}`);
    error.code = 'PROVIDER_HTTP_ERROR';
    throw error;
  }
  if (!response.body?.getReader) throw coded('PROVIDER_STREAM_MISSING', 'Provider returned no readable stream.');
  const declaredLength = Number(response.headers?.get?.('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.MAX_PROVIDER_STREAM_BYTES) {
    throw coded('PROVIDER_STREAM_TOO_LARGE', 'Provider stream exceeds the 4 MiB limit.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let inlineThinkBuffer = '';
  let malformed = 0;
  let doneEvent = false;
  let streamBytes = 0;
  let reachedEof = false;
  const toolAccum = new Map();

  function emit(channel, text) {
    if (!text) return;
    if (content.length + reasoning.length + text.length > LIMITS.MAX_PROVIDER_OUTPUT_CHARS) {
      throw coded('PROVIDER_OUTPUT_TOO_LARGE', 'Provider output exceeds the 1 MiB limit.');
    }
    if (channel === 'content') content += text;
    else reasoning += text;
    onDelta(channel, text);
  }

  function processLine(line) {
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
    const data = line.slice(5).replace(/^ /, '');
    if (data === '[DONE]') { doneEvent = true; return; }
    let parsed;
    try { parsed = JSON.parse(data); }
    catch {
      malformed += 1;
      if (malformed > 16) throw coded('PROVIDER_MALFORMED_SSE', 'Provider emitted too many malformed SSE records.');
      return;
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) return;
    emit('reasoning', extractReasoningChunk(delta));
    if (typeof delta.content === 'string' && delta.content) {
      inlineThinkBuffer += delta.content;
      const split = splitInlineThink(inlineThinkBuffer);
      emit('content', split.content);
      emit('reasoning', split.reasoning);
      inlineThinkBuffer = split.remainder;
    }
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) {
      throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider emitted a malformed tool-call collection.');
    }
    for (const call of delta.tool_calls || []) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) {
        throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider emitted a malformed tool call.');
      }
      const index = Number.isInteger(call.index) ? call.index : toolAccum.size;
      if (index < 0 || index >= MAX_TOOL_CALLS) {
        throw coded('PROVIDER_INVALID_TOOL_CALL', `Provider tool-call index must be between 0 and ${MAX_TOOL_CALLS - 1}.`);
      }
      if (!toolAccum.has(index)) toolAccum.set(index, { id: '', name: '', arguments: '' });
      const item = toolAccum.get(index);
      if (call.id != null) {
        if (typeof call.id !== 'string') throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider tool-call id must be a string.');
        item.id = call.id;
      }
      if (call.function?.name != null) {
        if (typeof call.function.name !== 'string') throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider tool name must be a string.');
        item.name += call.function.name;
      }
      if (call.function?.arguments != null) {
        if (typeof call.function.arguments !== 'string') throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider tool arguments must be a string.');
        item.arguments += call.function.arguments;
      }
      if (item.id.length > MAX_TOOL_CALL_ID_CHARS || item.name.length > MAX_TOOL_NAME_CHARS || item.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
        throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider tool call exceeds the supported size limits.');
      }
    }
  }

  try {
    while (!doneEvent) {
      const { value, done } = await raceWithSignal(reader.read(), signal);
      throwIfAborted(signal);
      if (done) reachedEof = true;
      if (value) {
        streamBytes += value.byteLength;
        if (streamBytes > LIMITS.MAX_PROVIDER_STREAM_BYTES) {
          throw coded('PROVIDER_STREAM_TOO_LARGE', 'Provider stream exceeds the 4 MiB limit.');
        }
      }
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (signal?.aborted) throw coded('CANCELLED', 'Provider stream cancelled.');
        processLine(line.trim());
        if (doneEvent) break;
      }
      if (done) break;
    }
    if (buffer.trim() && !doneEvent) processLine(buffer.trim());
  } finally {
    if (!reachedEof) {
      try { await reader.cancel(); } catch { /* already closed */ }
    } else {
      try { reader.releaseLock?.(); } catch { /* no lock to release */ }
    }
  }

  if (inlineThinkBuffer) {
    if (inlineThinkBuffer.startsWith('<think>')) emit('reasoning', inlineThinkBuffer.slice(7));
    else emit('content', inlineThinkBuffer);
  }
  const seenToolCallIds = new Set();
  const toolCalls = [...toolAccum.values()].map(call => {
    const invalidIdCharacter = [...call.id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!call.id || invalidIdCharacter || !/^[A-Za-z0-9_-]{1,128}$/.test(call.name)) {
      throw coded('PROVIDER_INVALID_TOOL_CALL', 'Provider emitted an invalid tool-call id or name.');
    }
    if (seenToolCallIds.has(call.id)) throw coded('PROVIDER_DUPLICATE_TOOL_CALL_ID', 'Provider emitted a duplicate tool-call id.');
    seenToolCallIds.add(call.id);
    return { id: call.id, name: call.name, rawArgs: call.arguments };
  });
  return { content: content || null, reasoning: reasoning || null, toolCalls: toolCalls.length ? toolCalls : null };
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
