/**
 * Chat: messages rendering, tool blocks, streaming.
 */
import { state, resetStream } from './state.js';

const $ = id => document.getElementById(id);

const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
const STOP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMarkdown(text) {
  try {
    return window.marked.parse(text);
  } catch {
    return escapeHtml(text);
  }
}

export function setupMarkdown() {
  try {
    window.marked.setOptions({ gfm: true, breaks: true });
  } catch { /* ignore */ }
}

export function scrollToBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
}

// =============================================================
// Messages
// =============================================================

export function renderMessages() {
  const messagesEl = $('messages');
  messagesEl.innerHTML = '';
  if (state.chatHistory.length === 0) {
    renderEmptyState();
    return;
  }
  for (const msg of state.chatHistory) {
    if (msg.role === 'user') renderUserMessage(msg);
    else if (msg.role === 'assistant') renderAssistantMessage(msg);
  }
  scrollToBottom();
}

function renderEmptyState() {
  $('messages').innerHTML = `
    <div class="empty-state">
      <div class="empty-art" aria-hidden="true">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 9.5 8 10 4.6-.5 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/></svg>
      </div>
      <h3>Typst Side Agent</h3>
      <p>Describe a goal. The agent uses tools to read the document and diagnostics when needed.</p>
      <p class="hint">Use <strong>+ Add</strong> to attach editor selection, a preview screenshot, or an opened image.</p>
    </div>
  `;
}

export function renderUserMessage(msg) {
  const messagesEl = $('messages');
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const text = typeof msg === 'string' ? msg : (msg.content || '');
  const sent = (typeof msg === 'object' && msg.sentAttachments) ? msg.sentAttachments : null;

  const group = document.createElement('div');
  group.className = 'msg-group msg-user';

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'You';

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (hasSentAttachmentVisual(sent)) {
    const row = document.createElement('div');
    row.className = 'msg-user-attachments';
    if (sent.document) {
      const pill = document.createElement('span');
      pill.className = 'msg-user-pill';
      pill.textContent = 'Full document';
      row.appendChild(pill);
    }
    if ((sent.diagnosticsCount || 0) > 0) {
      const pill = document.createElement('span');
      pill.className = 'msg-user-pill';
      pill.textContent = `Diagnostics (${sent.diagnosticsCount})`;
      row.appendChild(pill);
    }
    (sent.selections || []).forEach((sel, i) => {
      const pill = document.createElement('span');
      pill.className = 'msg-user-pill msg-user-pill-long';
      const t = (sel.text || '').replace(/\s+/g, ' ').trim();
      pill.textContent = t
        ? `Selection ${i + 1}: ${t.slice(0, 96)}${t.length > 96 ? '…' : ''}`
        : `Selection ${i + 1}`;
      row.appendChild(pill);
    });
    if (sent.previews && sent.previews.length > 0) {
      const thumbs = document.createElement('div');
      thumbs.className = 'msg-user-thumbs';
      sent.previews.forEach((p, i) => {
        if (!p?.dataUrl) return;
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
    body.appendChild(row);
  }

  const textEl = document.createElement('div');
  textEl.className = 'msg-user-text';
  textEl.textContent = text;
  body.appendChild(textEl);

  group.appendChild(role);
  group.appendChild(body);
  messagesEl.appendChild(group);
}

function parseToolCallArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

/** Map persisted or imported tool_calls into the UI shape `{ id, name, args }`. */
function normalizeToolCallsForSegments(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map(tc => {
    const fn = tc.function;
    if (fn && typeof fn.name === 'string') {
      return { id: tc.id, name: fn.name, args: parseToolCallArgs(fn.arguments) };
    }
    return { id: tc.id, name: tc.name, args: tc.args || {} };
  });
}

/**
 * Segments saved during streaming, or synthesized from a flat assistant record
 * (e.g. imported session JSON).
 */
function assistantDisplaySegments(msg) {
  if (Array.isArray(msg.segments) && msg.segments.length > 0) return msg.segments;
  const segments = [];
  if (msg.reasoning) segments.push({ type: 'reasoning', content: msg.reasoning });
  const calls = normalizeToolCallsForSegments(msg.toolCalls);
  if (calls.length > 0) segments.push({ type: 'tools', calls, results: {} });
  if (msg.content) segments.push({ type: 'text', content: msg.content });
  return segments;
}

export function renderAssistantMessage(msg) {
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
      el.innerHTML = renderMarkdown(seg.content);
      body.appendChild(el);
    }
  }

  group.appendChild(role);
  group.appendChild(body);
  messagesEl.appendChild(group);
}

function hasSentAttachmentVisual(sent) {
  if (!sent) return false;
  return !!(
    sent.document ||
    (sent.diagnosticsCount || 0) > 0 ||
    (sent.selections && sent.selections.length) ||
    (sent.previews && sent.previews.length)
  );
}

// =============================================================
// Tool blocks
// =============================================================

function toolCallLabel(name, args) {
  switch (name) {
    case 'read_document':    return 'Read document';
    case 'read_diagnostics':
      return args.delay_ms != null && Number(args.delay_ms) > 0
        ? `Read diagnostics (wait ${args.delay_ms} ms)`
        : 'Read diagnostics';
    case 'replace_lines':    return `Replace lines ${args.start_line}–${args.end_line}`;
    case 'insert_at_cursor': return 'Insert at cursor';
    case 'replace_selection':return 'Replace selection';
    case 'search_replace': {
      const s = (args.search || '').replace(/\n/g, '↵');
      return `Search & replace: "${s.length > 36 ? s.slice(0, 36) + '…' : s}"`;
    }
    case 'patch_document': {
      const n = Array.isArray(args.edits) ? args.edits.length : 0;
      return `Patch document (${n} edit${n === 1 ? '' : 's'})`;
    }
    default:
      if (name?.startsWith('mcp__')) return 'MCP: ' + name.slice(5).replace(/__/g, ' / ');
      return name;
  }
}

function toolCallPreview(name, args) {
  if (name === 'read_document') return args?.max_chars ? `max_chars=${args.max_chars}` : '(default size)';
  if (name === 'read_diagnostics') {
    const delay = Number(args?.delay_ms || 0);
    return delay > 0 ? `wait ${delay} ms before reading diagnostics` : 'read diagnostics immediately';
  }
  if (name === 'replace_lines') return args?.new_content || '';
  if (name === 'search_replace') return `- ${args?.search || ''}\n+ ${args?.replace || ''}`;
  if (name === 'insert_at_cursor' || name === 'replace_selection') return args?.text || '';
  if (name === 'patch_document' && Array.isArray(args?.edits)) {
    return args.edits.map((e, i) => `[${i + 1}]\n- ${e.search || ''}\n+ ${e.replace || ''}`).join('\n\n');
  }
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

export function renderToolBlock(tc, applied, result) {
  const el = document.createElement('div');
  el.className = 'tool-block';
  el.dataset.callId = tc.id;

  const header = document.createElement('div');
  header.className = 'tool-block-header';

  const label = document.createElement('div');
  label.className = 'tool-block-label';

  const icon = document.createElement('span');
  icon.className = 'tool-block-icon';
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-block-name';
  nameEl.textContent = toolCallLabel(tc.name, tc.args || {});

  label.appendChild(icon);
  label.appendChild(nameEl);

  const status = document.createElement('span');
  if (applied) {
    if (result && result.ok === false) {
      status.className = 'tool-status tool-status-err';
      status.textContent = 'failed';
    } else {
      status.className = 'tool-status tool-status-ok';
      status.textContent = 'done';
    }
  } else {
    status.className = 'tool-status tool-status-pending';
    status.textContent = 'running…';
  }

  header.appendChild(label);
  header.appendChild(status);
  el.appendChild(header);

  const detail = document.createElement('pre');
  detail.className = 'tool-block-detail';
  const preview = toolCallPreview(tc.name, tc.args || {});
  if (preview) detail.textContent = preview;
  el.appendChild(detail);

  header.addEventListener('click', () => detail.classList.toggle('show'));
  return el;
}

// =============================================================
// Reasoning ("thinking") block
// =============================================================

/**
 * Build a collapsible "Thinking" block.
 * @param {string} text initial text content (may be empty for live streaming)
 * @param {boolean} live when true, render expanded with a pulsing indicator
 */
export function renderReasoningBlock(text, live) {
  const el = document.createElement('div');
  el.className = 'reasoning-block' + (live ? ' is-live' : '');

  const header = document.createElement('div');
  header.className = 'reasoning-header';
  header.innerHTML = `
    <span class="reasoning-icon">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.27a3 3 0 0 0-2.83 4.66 3 3 0 0 0 .58 4.91 3 3 0 0 0 1.5 4.94 3 3 0 0 0 5.25 2.04V4.5A2.5 2.5 0 0 0 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.27a3 3 0 0 1 2.83 4.66 3 3 0 0 1-.58 4.91 3 3 0 0 1-1.5 4.94 3 3 0 0 1-5.25 2.04V4.5A2.5 2.5 0 0 1 14.5 2z"/></svg>
    </span>
    <span class="reasoning-title">${live ? 'Thinking' : 'Thought'}</span>
    <span class="reasoning-meta"></span>
    <svg class="reasoning-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
  `;

  const body = document.createElement('pre');
  body.className = 'reasoning-body';
  body.textContent = text || '';

  el.appendChild(header);
  el.appendChild(body);

  if (live) {
    el.classList.add('open');
  }

  header.addEventListener('click', () => el.classList.toggle('open'));
  updateReasoningMeta(el);
  return el;
}

function updateReasoningMeta(el) {
  const body = el.querySelector('.reasoning-body');
  const meta = el.querySelector('.reasoning-meta');
  if (!body || !meta) return;
  const chars = body.textContent.length;
  if (!chars) { meta.textContent = ''; return; }
  meta.textContent = chars > 1024 ? `${(chars / 1024).toFixed(1)}k chars` : `${chars} chars`;
}

// =============================================================
// Streaming UI
// =============================================================

export function createStreamingMessage() {
  const messagesEl = $('messages');
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const group = document.createElement('div');
  group.className = 'msg-group msg-assistant streaming';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Assistant';
  const body = document.createElement('div');
  body.className = 'msg-body';
  group.appendChild(role);
  group.appendChild(body);
  messagesEl.appendChild(group);
  scrollToBottom();
  return { messageEl: group, bodyEl: body };
}

function ensureContentSegment() {
  // If a reasoning segment is active, finalize it before starting answer text
  // so the "Thinking" block visually closes once the answer begins streaming.
  if (state.stream.currentReasoningEl) {
    state.stream.currentReasoningEl.classList.remove('open', 'is-live');
    state.stream.currentReasoningEl = null;
  }
  if (state.stream.currentContentEl) return;
  state.stream.currentContentEl = document.createElement('div');
  state.stream.currentContentEl.className = 'msg-content';
  state.stream.currentText = '';
  state.stream.bodyEl.appendChild(state.stream.currentContentEl);
  state.stream.segments.push({ type: 'text', content: '' });
}

export function appendChunk(chunk) {
  if (!state.isStreaming || !state.stream.bodyEl || !chunk) return;
  ensureContentSegment();
  state.stream.currentText += chunk;
  state.stream.allText += chunk;
  state.stream.currentContentEl.innerHTML = renderMarkdown(state.stream.currentText);
  const lastSeg = state.stream.segments[state.stream.segments.length - 1];
  if (lastSeg?.type === 'text') lastSeg.content = state.stream.currentText;
  scrollToBottom();
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
  // Reasoning always precedes the next content/tool segment. If we were already
  // emitting answer text, close that text segment so the order is preserved.
  state.stream.currentContentEl = null;
  state.stream.currentText = '';
  ensureReasoningSegment();
  state.stream.currentReasoningText += chunk;
  state.stream.allReasoning += chunk;
  const body = state.stream.currentReasoningEl.querySelector('.reasoning-body');
  if (body) {
    body.textContent = state.stream.currentReasoningText;
    updateReasoningMeta(state.stream.currentReasoningEl);
  }
  const lastSeg = state.stream.segments[state.stream.segments.length - 1];
  if (lastSeg?.type === 'reasoning') lastSeg.content = state.stream.currentReasoningText;
  scrollToBottom();
}

export function handleToolCalls(calls) {
  if (!state.isStreaming || !state.stream.bodyEl) return;
  state.stream.currentContentEl = null;
  state.stream.currentText = '';
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
  scrollToBottom();
}

/**
 * Show a "waiting on the page" banner inside a tool block and surface Retry /
 * Skip buttons. The agent background polls the page every ~1.5s; Retry just
 * accelerates that poll, Skip cancels this single tool call so the model sees
 * a short error and can try something else.
 */
export function markPreflightWaiting({ callId, missing, hint }) {
  const block = findToolBlock(callId);
  if (!block) return;

  const status = block.querySelector('.tool-status');
  if (status) {
    status.className = 'tool-status tool-status-waiting';
    status.textContent = 'needs page…';
  }

  let banner = block.querySelector('.tool-preflight');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'tool-preflight';

    const msg = document.createElement('div');
    msg.className = 'tool-preflight-msg';
    banner.appendChild(msg);

    const missingRow = document.createElement('div');
    missingRow.className = 'tool-preflight-missing';
    banner.appendChild(missingRow);

    const actions = document.createElement('div');
    actions.className = 'tool-preflight-actions';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'tool-preflight-btn tool-preflight-retry';
    retry.textContent = 'Retry now';
    retry.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AI_TOOL_PREFLIGHT_RESOLVE', callId, action: 'retry' }).catch(() => {});
    });

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'tool-preflight-btn tool-preflight-skip';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AI_TOOL_PREFLIGHT_RESOLVE', callId, action: 'cancel' }).catch(() => {});
    });

    actions.appendChild(retry);
    actions.appendChild(skip);
    banner.appendChild(actions);
    block.appendChild(banner);
  }

  banner.querySelector('.tool-preflight-msg').textContent = hint || 'Waiting for the typst.app page…';
  const missingRow = banner.querySelector('.tool-preflight-missing');
  if (missingRow) {
    missingRow.textContent = Array.isArray(missing) && missing.length > 0
      ? `Missing: ${missing.join(', ')}`
      : '';
  }
  scrollToBottom();
}

export function markPreflightReady(callId) {
  const block = findToolBlock(callId);
  if (!block) return;
  const banner = block.querySelector('.tool-preflight');
  if (banner) banner.remove();
  const status = block.querySelector('.tool-status');
  if (status) {
    status.className = 'tool-status tool-status-pending';
    status.textContent = 'running…';
  }
}

function findToolBlock(callId) {
  const bodyEl = state.stream.bodyEl;
  if (bodyEl) {
    const inStream = bodyEl.querySelector(`[data-call-id="${callId}"]`);
    if (inStream) return inStream;
  }
  return $('messages').querySelector(`[data-call-id="${callId}"]`);
}

export function handleToolResult(callId, name, result) {
  const block = findToolBlock(callId);
  if (!block) return;
  const banner = block.querySelector('.tool-preflight');
  if (banner) banner.remove();
  const status = block.querySelector('.tool-status');
  const detail = block.querySelector('.tool-block-detail');

  if (result?.ok) {
    status.className = 'tool-status tool-status-ok';
    if (name === 'read_document') {
      const tr = result.truncated ? ' (truncated)' : '';
      status.textContent = `${result.doc_chars ?? '?'} chars${tr}`;
    } else if (name === 'read_diagnostics') {
      const n = Array.isArray(result.diagnostics) ? result.diagnostics.length : 0;
      const err = result.error_count ?? 0;
      const warn = result.warning_count ?? 0;
      const spell = result.spelling_count ?? 0;
      if (!n) {
        status.textContent = 'clean';
      } else {
        const parts = [];
        if (err) parts.push(`${err} err`);
        if (warn) parts.push(`${warn} warn`);
        if (spell) parts.push(`${spell} spell`);
        status.textContent = parts.length ? parts.join(', ') : `${n} diag`;
      }
      if (detail) {
        if (!n) {
          detail.textContent = 'No diagnostics.';
        } else {
          const lines = result.diagnostics.slice(0, 8).map((d, i) => {
            // Spelling rows come from a separate highlight layer (purple
            // squiggle) and are advisory only — render them as [SPELLING]
            // regardless of severity so they don't blend into compiler
            // warnings. Fall back to the severity label for everything else.
            const tag = d?.kind === 'spelling'
              ? 'SPELLING'
              : (d?.severity || 'info').toUpperCase();
            const line = Number.isFinite(d?.line) ? `L${d.line}` : 'L?';
            const col = Number.isFinite(d?.column) ? `:${d.column}` : '';
            const msg = (d?.message || '').replace(/\s+/g, ' ').trim() || '(no message)';
            return `${i + 1}. [${tag}] ${line}${col} ${msg}`;
          });
          if (n > 8) lines.push(`... and ${n - 8} more`);
          detail.textContent = lines.join('\n');
        }
      }
    } else if (name === 'patch_document') {
      const applied = result.edits_applied ?? 0;
      const skipped = result.skipped_count ?? 0;
      status.textContent = skipped ? `${applied} ok, ${skipped} skipped` : `${applied} applied`;
    } else {
      status.textContent = 'done';
    }
  } else {
    status.className = 'tool-status tool-status-err';
    status.textContent = (result?.error || 'failed').slice(0, 50);
  }

  for (const seg of state.stream.segments) {
    if (seg.type === 'tools' && seg.calls.find(c => c.id === callId)) {
      seg.results[callId] = result;
    }
  }
  scrollToBottom();
}

export function finalizeStream(onSave) {
  if (state.stream.messageEl) state.stream.messageEl.classList.remove('streaming');
  if (state.stream.currentReasoningEl) {
    state.stream.currentReasoningEl.classList.remove('open', 'is-live');
  }
  const hasText = !!state.stream.allText;
  const hasTools = state.stream.toolCalls.length > 0;
  const hasReasoning = !!state.stream.allReasoning;
  if (hasText || hasTools || hasReasoning) {
    const entry = {
      role: 'assistant',
      content: state.stream.allText || '',
      segments: state.stream.segments
    };
    if (hasTools) entry.toolCalls = state.stream.toolCalls;
    if (hasReasoning) entry.reasoning = state.stream.allReasoning;
    state.chatHistory.push(entry);
  } else if (state.stream.messageEl) {
    state.stream.messageEl.remove();
  }
  resetStream();
  state.isStreaming = false;
  setSendButtonStop(false);
  onSave?.();
}

export function failStream(errorText, setStatus) {
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
