/**
 * Worker-side mirror of the streamed response. It lets a run that outlives the
 * side panel still persist a bounded assistant turn to the captured session.
 */
import { PROTOCOL } from '../../shared/protocol.js';
import { sessionGet, sessionUpdate } from '../storage.js';

const MAX_TRANSCRIPT_TEXT_CHARS = 250_000;
const MAX_TRANSCRIPT_TOOL_CALLS = 128;
const MAX_TRANSCRIPT_SEGMENTS = 256;

export function createRunTranscript() {
  return { content: '', reasoning: '', segments: [], toolCalls: [], truncatedContent: false, truncatedReasoning: false };
}

function appendBoundedText(current, value, transcript, flag) {
  if (!value || transcript[flag]) return current;
  const available = MAX_TRANSCRIPT_TEXT_CHARS - current.length;
  if (available <= 0) {
    transcript[flag] = true;
    return current;
  }
  if (value.length <= available) return current + value;
  transcript[flag] = true;
  return current + value.slice(0, Math.max(0, available - 24)) + '\n… (transcript truncated)';
}

function recordStreamBatch(transcript, payload) {
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    if (!item?.text || !['content', 'reasoning'].includes(item.channel)) continue;
    const isContent = item.channel === 'content';
    const segmentType = isContent ? 'text' : 'reasoning';
    const field = isContent ? 'content' : 'reasoning';
    const flag = isContent ? 'truncatedContent' : 'truncatedReasoning';
    const before = transcript[field];
    transcript[field] = appendBoundedText(before, item.text, transcript, flag);
    const appended = transcript[field].slice(before.length);
    if (!appended) continue;
    const previous = transcript.segments.at(-1);
    if (previous?.type === segmentType) previous.content += appended;
    else if (transcript.segments.length < MAX_TRANSCRIPT_SEGMENTS) transcript.segments.push({ type: segmentType, content: appended });
  }
}

export function recordTranscriptEvent(run, type, payload) {
  const transcript = run.transcript;
  if (!transcript) return;
  if (type === PROTOCOL.AI_STREAM_BATCH) {
    recordStreamBatch(transcript, payload);
    return;
  }
  if (type === PROTOCOL.AI_TOOL_CALLS) {
    const calls = (Array.isArray(payload.calls) ? payload.calls : [])
      .slice(0, Math.max(0, MAX_TRANSCRIPT_TOOL_CALLS - transcript.toolCalls.length))
      .map(call => ({ id: call.id, name: call.name, args: call.args || {} }));
    transcript.toolCalls.push(...calls);
    if (calls.length && transcript.segments.length < MAX_TRANSCRIPT_SEGMENTS) transcript.segments.push({ type: 'tools', calls, results: {} });
    return;
  }
  if (type === PROTOCOL.AI_TOOL_RESULT) {
    for (const segment of transcript.segments) {
      if (segment.type === 'tools' && segment.calls.some(call => call.id === payload.callId)) {
        segment.results[payload.callId] = payload.result;
        break;
      }
    }
  }
}

export function buildTranscriptEntry(run, responseStatus = 'incomplete') {
  const transcript = run.transcript;
  if (!transcript || (!transcript.content && !transcript.reasoning && transcript.toolCalls.length === 0)) return null;
  const entry = {
    role: 'assistant',
    runId: run.runId,
    content: transcript.content,
    segments: transcript.segments,
    responseStatus: responseStatus === 'complete' ? 'complete' : 'incomplete'
  };
  if (transcript.toolCalls.length) entry.toolCalls = transcript.toolCalls;
  if (transcript.reasoning) entry.reasoning = transcript.reasoning;
  return entry;
}

/**
 * The side panel and the worker can both persist the same assistant turn. A
 * shared run id makes the reconciliation exact; the content comparison remains
 * only for records written before run ids were stored.
 */
export function isSameAssistantTurn(previous, entry) {
  if (!previous || previous.role !== 'assistant') return false;
  if (typeof previous.runId === 'string' && previous.runId && typeof entry?.runId === 'string' && entry.runId) {
    return previous.runId === entry.runId;
  }
  return previous.content === entry.content
    && previous.reasoning === entry.reasoning
    && JSON.stringify(previous.toolCalls || []) === JSON.stringify(entry.toolCalls || []);
}

export async function persistRunTranscriptToStorage({ sessionId, sourceMessages, entry }) {
  const session = await sessionGet(sessionId);
  if (!session) return;
  const source = Array.isArray(sourceMessages) ? sourceMessages : [];
  const current = Array.isArray(session.messages) ? session.messages : [];
  const messages = current.length >= source.length ? current.slice() : source.slice();
  const previous = messages.at(-1);
  if (isSameAssistantTurn(previous, entry)) {
    if (previous.responseStatus === entry.responseStatus) return;
    messages[messages.length - 1] = { ...previous, responseStatus: entry.responseStatus };
    await sessionUpdate(sessionId, { messages });
    return;
  }
  messages.push(entry);
  await sessionUpdate(sessionId, { messages });
}
