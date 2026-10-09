/**
 * Chat transcript rendering and the facade over the chat modules:
 * markdown.js (sanitized rendering), stream-view.js (live streaming),
 * tool-blocks.js (tool calls and approvals), reasoning-block.js, and
 * revert-control.js (response-level recovery actions).
 */
import { state } from './state.js';
import { $, scrollToBottom, svgIcon } from './chat-dom.js';
import { renderMarkdownInto } from './markdown.js';
import { renderReasoningBlock } from './reasoning-block.js';
import { handleToolResult as handleToolResultBlock, renderToolBlock } from './tool-blocks.js';
import { renderEditCheckpointControl, resetRevertConfirmation } from './revert-control.js';
import { flushPendingRender } from './stream-view.js';

export { isAllowedMarkdownUrl, renderMarkdownFragment, renderMarkdownInto, setupMarkdown } from './markdown.js';
export { scrollToBottom } from './chat-dom.js';
export { renderReasoningBlock } from './reasoning-block.js';
export { markApprovalRequired, markPreflightReady, markPreflightWaiting, renderToolBlock } from './tool-blocks.js';
export {
  configureResponseRecoveryActions, latestEditCheckpoint, resetRevertConfirmation, updateEditCheckpointInHistory
} from './revert-control.js';
export {
  appendChunk, appendReasoning, createStreamingMessage, failStream, finalizeStream, flushPendingRender,
  handleToolCalls, setSendButtonStop
} from './stream-view.js';

const SUGGESTIONS = Object.freeze([
  {
    prompt: 'Inspect the current diagnostics, explain the errors, and propose fixes.',
    title: 'Fix compile errors',
    hint: 'Inspect diagnostics and prepare a patch',
    icon: svgIcon(15, 2, '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.74 3h15.12a2 2 0 0 0 1.74-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/>')
  },
  {
    prompt: 'Review the current document and suggest the highest-impact improvements.',
    title: 'Improve this document',
    hint: 'Review structure, clarity, and Typst style',
    icon: svgIcon(15, 2, '<path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>')
  },
  {
    prompt: 'Read the current document and explain how it works.',
    title: 'Explain this file',
    hint: 'Walk through unfamiliar Typst code',
    icon: svgIcon(15, 2, '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>')
  }
]);

export function handleToolResult(callId, name, result) {
  handleToolResultBlock(callId, name, result, { flush: flushPendingRender });
}

export function latestCompletedResponseIndex(history) {
  for (let index = (Array.isArray(history) ? history.length : 0) - 1; index >= 0; index--) {
    const candidate = history[index];
    if (candidate?.role === 'assistant' && candidate.responseStatus === 'complete') return index;
  }
  return -1;
}

export function renderMessages() {
  resetRevertConfirmation();
  const messagesEl = $('messages');
  messagesEl.innerHTML = '';
  if (state.chatHistory.length === 0) {
    renderEmptyState();
    return;
  }
  const latestCompletedResponse = latestCompletedResponseIndex(state.chatHistory);
  for (let index = 0; index < state.chatHistory.length; index++) {
    const msg = state.chatHistory[index];
    if (msg.role === 'user') renderUserMessage(msg);
    else if (msg.role === 'assistant') renderAssistantMessage(msg, { showSnapshot: index === latestCompletedResponse });
  }
  scrollToBottom();
}

function renderEmptyState() {
  const messages = $('messages');
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const suggestions = document.createElement('div');
  suggestions.className = 'empty-suggestions';
  suggestions.setAttribute('aria-label', 'Suggested prompts');
  const input = $('user-input');
  for (const suggestion of SUGGESTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'empty-suggestion';
    button.dataset.prompt = suggestion.prompt;
    button.disabled = !!input?.disabled;
    const icon = document.createElement('span');
    icon.className = 'empty-suggestion-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = suggestion.icon;
    const copy = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = suggestion.title;
    const small = document.createElement('small');
    small.textContent = suggestion.hint;
    copy.append(strong, small);
    const arrow = document.createElement('span');
    arrow.className = 'empty-suggestion-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    button.append(icon, copy, arrow);
    button.addEventListener('click', () => {
      if (!input || input.disabled) return;
      input.value = suggestion.prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    suggestions.appendChild(button);
  }
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Choose a starting point or ask about the open document below.';
  empty.append(suggestions, hint);
  messages.replaceChildren(empty);
}

function pill(text, extraClass = '') {
  const element = document.createElement('span');
  element.className = `msg-user-pill${extraClass ? ` ${extraClass}` : ''}`;
  element.textContent = text;
  return element;
}

function renderSentAttachments(sent) {
  const row = document.createElement('div');
  row.className = 'msg-user-attachments';
  if (sent.legacyDocument || sent.document) row.appendChild(pill('Full document'));
  const legacyDiagnosticsCount = sent.legacyDiagnosticsCount || sent.diagnosticsCount || 0;
  if (legacyDiagnosticsCount > 0) row.appendChild(pill(`Diagnostics (${legacyDiagnosticsCount})`));
  (sent.selections || []).forEach((sel, i) => {
    const t = (sel.text || '').replace(/\s+/g, ' ').trim();
    const file = typeof sel.fileLabel === 'string' && sel.fileLabel ? ` · ${sel.fileLabel}` : '';
    const text = t ? `Selection ${i + 1}${file}: ${t.slice(0, 96)}${t.length > 96 ? '…' : ''}` : `Selection ${i + 1}${file}`;
    row.appendChild(pill(text, 'msg-user-pill-long'));
  });
  if (sent.previews && sent.previews.length > 0) {
    const thumbs = document.createElement('div');
    thumbs.className = 'msg-user-thumbs';
    sent.previews.forEach((p, i) => {
      if (!p?.dataUrl) {
        const marker = pill(`Preview ${i + 1} not retained`);
        marker.title = p?.reason || 'Preview omitted from stored history.';
        thumbs.appendChild(marker);
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'msg-user-thumb-wrap';
      const img = document.createElement('img');
      img.className = 'msg-user-thumb';
      img.src = p.dataUrl;
      img.alt = `Attached image ${i + 1}`;
      wrap.appendChild(img);
      thumbs.appendChild(wrap);
    });
    row.appendChild(thumbs);
  }
  return row;
}

function hasSentAttachmentVisual(sent) {
  if (!sent) return false;
  return !!(
    sent.legacyDocument || sent.document ||
    (sent.legacyDiagnosticsCount || sent.diagnosticsCount || 0) > 0 ||
    (sent.selections && sent.selections.length) ||
    (sent.previews && sent.previews.length)
  );
}

export function renderUserMessage(msg) {
  const messagesEl = $('messages');
  messagesEl.querySelector('.empty-state')?.remove();

  const text = typeof msg === 'string' ? msg : (msg.content || '');
  const sent = (typeof msg === 'object' && msg.sentAttachments) ? msg.sentAttachments : null;

  const group = document.createElement('div');
  group.className = 'msg-group msg-user';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'You';
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (hasSentAttachmentVisual(sent)) body.appendChild(renderSentAttachments(sent));
  const textEl = document.createElement('div');
  textEl.className = 'msg-user-text';
  textEl.textContent = text;
  body.appendChild(textEl);
  group.append(role, body);
  messagesEl.appendChild(group);
}

function parseToolCallArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

/** Map persisted or imported tool_calls into the UI shape `{ id, name, args }`. */
function normalizeToolCallsForSegments(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map(tc => {
    const fn = tc.function;
    if (fn && typeof fn.name === 'string') return { id: tc.id, name: fn.name, args: parseToolCallArgs(fn.arguments) };
    return { id: tc.id, name: tc.name, args: tc.args || {} };
  });
}

/** Segments saved during streaming, or synthesized from a flat assistant record (e.g. imported JSON). */
function assistantDisplaySegments(msg) {
  if (Array.isArray(msg.segments) && msg.segments.length > 0) return msg.segments;
  const segments = [];
  if (msg.reasoning) segments.push({ type: 'reasoning', content: msg.reasoning });
  const calls = normalizeToolCallsForSegments(msg.toolCalls);
  if (calls.length > 0) segments.push({ type: 'tools', calls, results: {} });
  if (msg.content) segments.push({ type: 'text', content: msg.content });
  return segments;
}

export function renderAssistantMessage(msg, { showSnapshot = false } = {}) {
  const messagesEl = $('messages');
  const group = document.createElement('div');
  group.className = 'msg-group msg-assistant';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Assistant';
  const body = document.createElement('div');
  body.className = 'msg-body';

  for (const seg of assistantDisplaySegments(msg)) {
    if (seg.type === 'tools' && Array.isArray(seg.calls)) {
      for (const tc of seg.calls) body.appendChild(renderToolBlock(tc, true, seg.results?.[tc.id]));
    } else if (seg.type === 'reasoning' && seg.content) {
      body.appendChild(renderReasoningBlock(seg.content, /* live */ false));
    } else if (seg.type === 'text' && seg.content) {
      const el = document.createElement('div');
      el.className = 'msg-content';
      renderMarkdownInto(el, seg.content);
      body.appendChild(el);
    }
  }
  const checkpointControl = renderEditCheckpointControl(msg, { showSnapshot });
  if (checkpointControl) body.appendChild(checkpointControl);

  group.append(role, body);
  messagesEl.appendChild(group);
}
