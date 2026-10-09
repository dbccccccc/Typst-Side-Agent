/**
 * Live streaming view. Unfinished Markdown is appended as inert text, a
 * completed text segment crosses the sanitizer once, and reasoning, text, and
 * tool segments keep their exact arrival order.
 */
import { state, resetStream } from './state.js';
import { $, finishDomMutation, isNearBottom, scrollToBottom, svgIcon } from './chat-dom.js';
import { renderMarkdownInto } from './markdown.js';
import { finishReasoningMutation, renderReasoningBlock, updateReasoningMeta } from './reasoning-block.js';
import { renderToolBlock } from './tool-blocks.js';
import { clearRenderedSnapshotActions, renderEditCheckpointControl } from './revert-control.js';

const SEND_ICON = svgIcon(16, 2.2, '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>');
const STOP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

export function createStreamingMessage() {
  const messagesEl = $('messages');
  messagesEl.querySelector('.empty-state')?.remove();

  const group = document.createElement('div');
  group.className = 'msg-group msg-assistant streaming';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Assistant';
  const body = document.createElement('div');
  body.className = 'msg-body';
  group.append(role, body);
  messagesEl.appendChild(group);
  scrollToBottom();
  return { messageEl: group, bodyEl: body };
}

function scheduleStreamRender() {
  if (state.stream.renderFrame != null) return;
  state.stream.followBeforeRender = isNearBottom();
  state.stream.renderFrame = requestAnimationFrame(() => flushPendingRender());
}

/** Render at most once per frame; content text stays inert until its segment closes. */
export function flushPendingRender() {
  if (state.stream.renderFrame != null) cancelAnimationFrame(state.stream.renderFrame);
  state.stream.renderFrame = null;
  const follow = state.stream.followBeforeRender ?? isNearBottom();
  state.stream.followBeforeRender = null;
  if (state.stream.dirtyContent && state.stream.currentContentEl) {
    const pending = state.stream.currentText.slice(state.stream.renderedContentChars || 0);
    if (pending) state.stream.currentContentTextNode?.appendData(pending);
    state.stream.renderedContentChars = state.stream.currentText.length;
  }
  if (state.stream.dirtyReasoning && state.stream.currentReasoningEl) {
    const body = state.stream.currentReasoningEl.querySelector('.reasoning-body');
    if (body) {
      body.textContent = state.stream.currentReasoningText;
      updateReasoningMeta(state.stream.currentReasoningEl);
      finishReasoningMutation(body);
    }
  }
  const changed = state.stream.dirtyContent || state.stream.dirtyReasoning;
  state.stream.dirtyContent = false;
  state.stream.dirtyReasoning = false;
  if (changed) finishDomMutation(follow);
}

function finalizeCurrentContentSegment() {
  if (!state.stream.currentContentEl) return;
  flushPendingRender();
  const follow = isNearBottom();
  renderMarkdownInto(state.stream.currentContentEl, state.stream.currentText);
  finishDomMutation(follow);
  state.stream.currentContentEl = null;
  state.stream.currentContentTextNode = null;
  state.stream.currentText = '';
  state.stream.renderedContentChars = 0;
}

function closeReasoningSegment() {
  if (!state.stream.currentReasoningEl) return;
  flushPendingRender();
  state.stream.currentReasoningEl.classList.remove('open', 'is-live');
  state.stream.currentReasoningEl = null;
}

function ensureContentSegment() {
  // Answer text closes an open "Thinking" block so the order stays visible.
  closeReasoningSegment();
  if (state.stream.currentContentEl) return;
  state.stream.currentContentEl = document.createElement('div');
  state.stream.currentContentEl.className = 'msg-content';
  state.stream.currentContentTextNode = document.createTextNode('');
  state.stream.currentContentEl.appendChild(state.stream.currentContentTextNode);
  state.stream.currentText = '';
  state.stream.renderedContentChars = 0;
  state.stream.bodyEl.appendChild(state.stream.currentContentEl);
  state.stream.segments.push({ type: 'text', content: '' });
}

export function appendChunk(chunk) {
  if (!state.isStreaming || !state.stream.bodyEl || !chunk) return;
  ensureContentSegment();
  state.stream.currentText += chunk;
  state.stream.allText += chunk;
  state.stream.dirtyContent = true;
  const lastSeg = state.stream.segments[state.stream.segments.length - 1];
  if (lastSeg?.type === 'text') lastSeg.content = state.stream.currentText;
  scheduleStreamRender();
}

function ensureReasoningSegment() {
  if (state.stream.currentReasoningEl) return;
  const el = renderReasoningBlock('', /* live */ true);
  state.stream.bodyEl.appendChild(el);
  state.stream.currentReasoningEl = el;
  state.stream.currentReasoningText = '';
  state.stream.segments.push({ type: 'reasoning', content: '' });
}

export function appendReasoning(chunk) {
  if (!state.isStreaming || !state.stream.bodyEl || !chunk) return;
  // Reasoning precedes the next content/tool segment; close any open text first.
  finalizeCurrentContentSegment();
  ensureReasoningSegment();
  state.stream.currentReasoningText += chunk;
  state.stream.allReasoning += chunk;
  state.stream.dirtyReasoning = true;
  const lastSeg = state.stream.segments[state.stream.segments.length - 1];
  if (lastSeg?.type === 'reasoning') lastSeg.content = state.stream.currentReasoningText;
  scheduleStreamRender();
}

export function handleToolCalls(calls) {
  if (!state.isStreaming || !state.stream.bodyEl) return;
  finalizeCurrentContentSegment();
  flushPendingRender();
  const follow = isNearBottom();
  if (state.stream.currentReasoningEl) {
    state.stream.currentReasoningEl.classList.remove('open', 'is-live');
    state.stream.currentReasoningEl = null;
    state.stream.currentReasoningText = '';
  }
  const segCalls = [];
  for (const tc of calls) {
    state.stream.toolCalls.push(tc);
    segCalls.push(tc);
    state.stream.bodyEl.appendChild(renderToolBlock(tc, false));
  }
  state.stream.segments.push({ type: 'tools', calls: segCalls, results: {} });
  finishDomMutation(follow);
}

/** Close the stream, append the display record to history, and settle the UI. */
export function finalizeStream(onSave, { responseStatus = 'incomplete' } = {}) {
  finalizeCurrentContentSegment();
  flushPendingRender();
  if (state.stream.messageEl) state.stream.messageEl.classList.remove('streaming');
  if (state.stream.currentReasoningEl) state.stream.currentReasoningEl.classList.remove('open', 'is-live');
  const hasText = !!state.stream.allText;
  const hasTools = state.stream.toolCalls.length > 0;
  const hasReasoning = !!state.stream.allReasoning;
  let entry = null;
  const bodyEl = state.stream.bodyEl;
  if (hasText || hasTools || hasReasoning) {
    entry = {
      role: 'assistant',
      content: state.stream.allText || '',
      segments: state.stream.segments,
      responseStatus: responseStatus === 'complete' ? 'complete' : 'incomplete'
    };
    // The run id lets the worker recognize this exact turn when it persists its own copy.
    if (typeof state.activeRun?.runId === 'string') entry.runId = state.activeRun.runId;
    if (hasTools) entry.toolCalls = state.stream.toolCalls;
    if (hasReasoning) entry.reasoning = state.stream.allReasoning;
    state.chatHistory.push(entry);
  } else if (state.stream.messageEl) {
    state.stream.messageEl.remove();
  }
  resetStream();
  state.isStreaming = false;
  if (entry && bodyEl) {
    if (entry.responseStatus === 'complete') clearRenderedSnapshotActions();
    const checkpointControl = renderEditCheckpointControl(entry, { showSnapshot: entry.responseStatus === 'complete' });
    if (checkpointControl) bodyEl.appendChild(checkpointControl);
  }
  setSendButtonStop(false);
  onSave?.();
}

export function failStream(errorText, setStatus) {
  flushPendingRender();
  if (state.stream.messageEl) {
    state.stream.messageEl.classList.remove('streaming');
    if (!state.stream.allText && state.stream.toolCalls.length === 0) state.stream.messageEl.remove();
  }
  resetStream();
  state.isStreaming = false;
  setSendButtonStop(false);
  setStatus?.(errorText || 'Streaming failed', true);
}

export function setSendButtonStop(isStop) {
  const btn = $('send-btn');
  btn.classList.toggle('is-stop', isStop);
  btn.innerHTML = isStop ? STOP_ICON : SEND_ICON;
}
