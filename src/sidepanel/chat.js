/**
 * Chat: messages rendering, tool blocks, streaming.
 */
import { state, resetStream, bg } from './state.js';
import { PROTOCOL } from '../shared/protocol.js';
import { LIMITS } from '../shared/constants.js';
import { renderEditDiffPreview } from './edit-diff.js';
import {
  DEFAULT_EDIT_FILE_LABEL, isEditCheckpointToolName, latestEditCheckpointFromMessage,
  normalizePublicEditCheckpoint
} from '../shared/edit-checkpoint.js';

const $ = id => document.getElementById(id);

const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
const STOP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const REVERT_ICONS = Object.freeze({
  available: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 1 1-7 7"/></svg>',
  success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
  unavailable: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.74 3h15.12a2 2 0 0 0 1.74-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>',
  action: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 1 1-7 7"/></svg>'
});

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MARKDOWN_TAGS = Object.freeze([
  'p', 'br', 'strong', 'em', 'del', 'a', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td'
]);
const FOLLOW_THRESHOLD_PX = 72;
const REASONING_FOLLOW_THRESHOLD_PX = 2;
const reasoningScrollStates = new WeakMap();
const checkpointControlRenderers = new WeakMap();
let responseRecoveryActions = Object.freeze({ openSnapshots: async () => {} });
let pendingRevertConfirmation = null;
let revertDialogInitialized = false;

export function configureResponseRecoveryActions(actions = {}) {
  responseRecoveryActions = Object.freeze({
    openSnapshots: typeof actions.openSnapshots === 'function' ? actions.openSnapshots : async () => {}
  });
}

export function isAllowedMarkdownUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch { return false; }
}

function plainTextFragment(text) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(document.createTextNode(String(text || '')));
  return fragment;
}

/** The sole untrusted Markdown-to-DOM boundary. */
export function renderMarkdownFragment(text) {
  try {
    if (!window.marked?.parse || !window.DOMPurify?.sanitize) throw new Error('Renderer libraries unavailable');
    const dirty = window.marked.parse(String(text || ''));
    const fragment = window.DOMPurify.sanitize(dirty, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: ['href', 'title'],
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'frame', 'object', 'embed', 'img', 'video', 'audio', 'source', 'style', 'script'],
      FORBID_ATTR: ['style', 'src', 'srcset']
    });
    fragment.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href');
      if (!isAllowedMarkdownUrl(href)) {
        link.replaceWith(document.createTextNode(link.textContent || ''));
        return;
      }
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('target', '_blank');
    });
    return fragment;
  } catch (error) {
    console.warn('Typst Side Agent Markdown render failed:', error?.message || String(error));
    return plainTextFragment(text);
  }
}

export function renderMarkdownInto(element, text) {
  element.replaceChildren(renderMarkdownFragment(text));
}

export function setupMarkdown() {
  try {
    const renderer = new window.marked.Renderer();
    renderer.html = html => escapeHtml(typeof html === 'string' ? html : html?.text || '');
    renderer.link = (href, title, label) => {
      const text = escapeHtml(label || href || 'link');
      if (!isAllowedMarkdownUrl(href)) return text;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr}>${text}</a>`;
    };
    renderer.image = (href, title, alt) => {
      const label = `Image: ${escapeHtml(alt || 'attachment')}`;
      if (!isAllowedMarkdownUrl(href)) return label;
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttr}>${label}</a>`;
    };
    window.marked.setOptions({ gfm: true, breaks: true, renderer });
  } catch (error) {
    console.warn('Typst Side Agent Markdown setup failed:', error?.message || String(error));
  }
}

export function scrollToBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
  $('jump-latest')?.classList.add('hidden');
}

function isNearBottom() {
  const el = $('messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

function finishDomMutation(wasNearBottom) {
  if (wasNearBottom) scrollToBottom();
  else $('jump-latest')?.classList.remove('hidden');
}

// =============================================================
// Messages
// =============================================================

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

export function latestCompletedResponseIndex(history) {
  for (let index = (Array.isArray(history) ? history.length : 0) - 1; index >= 0; index--) {
    const candidate = history[index];
    if (candidate?.role === 'assistant' && candidate.responseStatus === 'complete') return index;
  }
  return -1;
}

function renderEmptyState() {
  const messages = $('messages');
  messages.innerHTML = `
    <div class="empty-state">
      <div class="empty-suggestions" aria-label="Suggested prompts">
        <button type="button" class="empty-suggestion" data-prompt="Inspect the current diagnostics, explain the errors, and propose fixes.">
          <span class="empty-suggestion-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.74 3h15.12a2 2 0 0 0 1.74-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>
          </span>
          <span><strong>Fix compile errors</strong><small>Inspect diagnostics and prepare a patch</small></span>
          <span class="empty-suggestion-arrow" aria-hidden="true">›</span>
        </button>
        <button type="button" class="empty-suggestion" data-prompt="Review the current document and suggest the highest-impact improvements.">
          <span class="empty-suggestion-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>
          </span>
          <span><strong>Improve this document</strong><small>Review structure, clarity, and Typst style</small></span>
          <span class="empty-suggestion-arrow" aria-hidden="true">›</span>
        </button>
        <button type="button" class="empty-suggestion" data-prompt="Read the current document and explain how it works.">
          <span class="empty-suggestion-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>
          </span>
          <span><strong>Explain this file</strong><small>Walk through unfamiliar Typst code</small></span>
          <span class="empty-suggestion-arrow" aria-hidden="true">›</span>
        </button>
      </div>
      <p class="hint">Choose a starting point or ask about the open document below.</p>
    </div>
  `;
  const input = $('user-input');
  messages.querySelectorAll('.empty-suggestion').forEach(button => {
    button.disabled = !!input?.disabled;
    button.addEventListener('click', () => {
      if (!input || input.disabled) return;
      input.value = button.dataset.prompt || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
  });
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
    if (sent.legacyDocument || sent.document) {
      const pill = document.createElement('span');
      pill.className = 'msg-user-pill';
      pill.textContent = 'Full document';
      row.appendChild(pill);
    }
    const legacyDiagnosticsCount = sent.legacyDiagnosticsCount || sent.diagnosticsCount || 0;
    if (legacyDiagnosticsCount > 0) {
      const pill = document.createElement('span');
      pill.className = 'msg-user-pill';
      pill.textContent = `Diagnostics (${legacyDiagnosticsCount})`;
      row.appendChild(pill);
    }
    (sent.selections || []).forEach((sel, i) => {
      const pill = document.createElement('span');
      pill.className = 'msg-user-pill msg-user-pill-long';
      const t = (sel.text || '').replace(/\s+/g, ' ').trim();
      const file = typeof sel.fileLabel === 'string' && sel.fileLabel ? ` · ${sel.fileLabel}` : '';
      pill.textContent = t
        ? `Selection ${i + 1}${file}: ${t.slice(0, 96)}${t.length > 96 ? '…' : ''}`
        : `Selection ${i + 1}${file}`;
      row.appendChild(pill);
    });
    if (sent.previews && sent.previews.length > 0) {
      const thumbs = document.createElement('div');
      thumbs.className = 'msg-user-thumbs';
      sent.previews.forEach((p, i) => {
        if (!p?.dataUrl) {
          const marker = document.createElement('span');
          marker.className = 'msg-user-pill';
          marker.textContent = `Preview ${i + 1} not retained`;
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

  group.appendChild(role);
  group.appendChild(body);
  messagesEl.appendChild(group);
}

export function latestEditCheckpoint(msg) {
  return latestEditCheckpointFromMessage(msg);
}

export function updateEditCheckpointInHistory(history, checkpoint) {
  let updated = 0;
  for (const message of Array.isArray(history) ? history : []) {
    for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
      if (segment?.type !== 'tools') continue;
      for (const call of Array.isArray(segment.calls) ? segment.calls : []) {
        if (!isEditCheckpointToolName(call?.name)) continue;
        const result = segment.results?.[call.id];
        if (result?.editCheckpoint?.id === checkpoint.id) {
          result.editCheckpoint = { ...result.editCheckpoint, ...checkpoint };
          updated += 1;
        }
      }
    }
  }
  return updated;
}

function normalizeCheckpointSummaries(values, fallback = null) {
  const candidates = Array.isArray(values) ? values.slice() : [];
  if (fallback) candidates.push(fallback);
  const summaries = [];
  const seen = new Set();
  for (const value of candidates) {
    const checkpoint = normalizePublicEditCheckpoint(value);
    if (!checkpoint || seen.has(checkpoint.id)) continue;
    seen.add(checkpoint.id);
    summaries.push(checkpoint);
  }
  return summaries;
}

function checkpointTargetLabel(checkpoint) {
  return checkpoint.fileLabel === DEFAULT_EDIT_FILE_LABEL
    ? 'the current Typst document'
    : checkpoint.fileLabel;
}

function createResponseActionButton({ className, label, title, icon, busy = false, disabled = false }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `response-action-button ${className}`;
  button.title = title;
  button.dataset.busy = busy ? 'true' : 'false';
  button.disabled = disabled || busy;
  const marker = document.createElement('span');
  marker.className = 'response-action-icon';
  marker.setAttribute('aria-hidden', 'true');
  if (busy) {
    const spinner = document.createElement('span');
    spinner.className = 'edit-revert-button-spinner';
    marker.appendChild(spinner);
  } else {
    marker.innerHTML = icon;
  }
  const text = document.createElement('span');
  text.textContent = label;
  button.append(marker, text);
  return button;
}

function createRevertStatus(checkpoint) {
  const status = document.createElement('span');
  const reverted = checkpoint.status === 'reverted';
  status.className = `edit-revert-status is-${reverted ? 'success' : 'unavailable'}`;
  status.title = reverted
    ? `Restored ${checkpointTargetLabel(checkpoint)} to its state before this response.`
    : checkpoint.unavailableReason || 'Revert data is unavailable.';
  const icon = document.createElement('span');
  icon.className = 'response-action-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = reverted ? REVERT_ICONS.success : REVERT_ICONS.unavailable;
  const label = document.createElement('span');
  label.className = reverted ? 'edit-revert-success' : '';
  label.textContent = reverted ? 'Changes reverted' : 'Revert unavailable';
  status.append(icon, label);
  return status;
}

function appendRevertPersistenceNote(control, message) {
  const note = document.createElement('div');
  note.className = 'edit-revert-note';
  note.setAttribute('role', 'alert');
  const marker = document.createElement('span');
  marker.className = 'edit-revert-note-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.textContent = '!';
  const copy = document.createElement('span');
  copy.className = 'edit-revert-note-copy edit-revert-error';
  copy.textContent = message;
  note.append(marker, copy);
  control.appendChild(note);
}

function syncRenderedCheckpointControls(checkpoints) {
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== 'reverted') continue;
    for (const control of document.querySelectorAll('.edit-revert-control')) {
      if (control.dataset.checkpointId !== checkpoint.id) continue;
      checkpointControlRenderers.get(control)?.(checkpoint);
    }
  }
}

function closeRevertConfirmation({ restoreFocus = false } = {}) {
  const pending = pendingRevertConfirmation;
  pendingRevertConfirmation = null;
  const layer = $('revert-dialog-layer');
  layer?.classList.add('hidden');
  layer?.removeAttribute('data-checkpoint-id');
  pending?.trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && pending?.trigger?.isConnected) pending.trigger.focus();
}

export function resetRevertConfirmation() {
  closeRevertConfirmation();
}

function ensureRevertDialogInitialized() {
  if (revertDialogInitialized) return;
  const layer = $('revert-dialog-layer');
  const close = $('revert-dialog-close');
  const cancel = $('revert-dialog-cancel');
  const confirm = $('revert-dialog-confirm');
  if (!layer || !close || !cancel || !confirm) return;
  revertDialogInitialized = true;

  close.addEventListener('click', () => closeRevertConfirmation({ restoreFocus: true }));
  cancel.addEventListener('click', () => closeRevertConfirmation({ restoreFocus: true }));
  layer.addEventListener('click', event => {
    if (event.target === layer) closeRevertConfirmation({ restoreFocus: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !layer.classList.contains('hidden')) {
      event.preventDefault();
      closeRevertConfirmation({ restoreFocus: true });
    }
  });
  confirm.addEventListener('click', () => {
    const pending = pendingRevertConfirmation;
    if (!pending) return;
    closeRevertConfirmation();
    Promise.resolve(pending.onConfirm()).catch(error => pending.onError(error));
  });
}

function openRevertConfirmation({ trigger, checkpoint, onConfirm, onError }) {
  ensureRevertDialogInitialized();
  const layer = $('revert-dialog-layer');
  const subtitle = $('revert-dialog-subtitle');
  const body = $('revert-dialog-body');
  const confirm = $('revert-dialog-confirm');
  if (!layer || !subtitle || !body || !confirm) {
    onError(new Error('The Revert confirmation could not be opened.'));
    return;
  }

  closeRevertConfirmation();
  pendingRevertConfirmation = { trigger, onConfirm, onError };
  trigger.setAttribute('aria-expanded', 'true');
  layer.dataset.checkpointId = checkpoint.id;
  subtitle.textContent = checkpointTargetLabel(checkpoint);

  const warning = document.createElement('div');
  warning.className = 'snapshot-dialog-note is-warning';
  warning.textContent = `Restore ${checkpointTargetLabel(checkpoint)} to its state before this response.`;
  const detail = document.createElement('div');
  detail.className = 'revert-dialog-detail';
  detail.textContent = 'Any later agent edits in this chat will be reverted first, newest to oldest. Reverting stops if a step no longer matches the live document.';
  body.replaceChildren(warning, detail);

  layer.classList.remove('hidden');
  confirm.focus();
}

function renderEditCheckpointControl(msg, { showSnapshot = false } = {}) {
  let checkpoint = latestEditCheckpoint(msg);
  if (!checkpoint && !showSnapshot) return null;
  const control = document.createElement('div');
  control.className = 'edit-revert-control response-recovery-control';
  if (checkpoint) control.dataset.checkpointId = checkpoint.id;
  control.dataset.hasSnapshot = showSnapshot ? 'true' : 'false';

  const render = (notice = '') => {
    const actionDisabled = state.isStreaming || !state.activeTabOnTypst;
    const viewState = notice ? 'error' : checkpoint?.status === 'reverted'
      ? 'success'
      : checkpoint?.status === 'unavailable' ? 'unavailable' : 'available';
    control.className = `edit-revert-control response-recovery-control is-${viewState}`;
    control.dataset.revertState = viewState;
    control.setAttribute('aria-busy', 'false');
    control.replaceChildren();

    const actions = document.createElement('div');
    actions.className = 'response-recovery-actions';
    if (checkpoint) {
      if (checkpoint.status === 'reverted' || checkpoint.status === 'unavailable') {
        actions.appendChild(createRevertStatus(checkpoint));
      } else {
        const button = createResponseActionButton({
          className: 'edit-revert-button',
          label: notice ? 'Try revert again' : 'Revert',
          title: `Restore ${checkpointTargetLabel(checkpoint)} to its state before this response. Later agent edits in this chat are reverted first.`,
          icon: REVERT_ICONS.action,
          disabled: actionDisabled
        });
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => requestRevert(button));
        actions.appendChild(button);
      }
    }
    if (control.dataset.hasSnapshot === 'true') {
      const snapshot = createResponseActionButton({
        className: 'response-snapshot-button',
        label: 'Snapshot',
        title: 'Open the document snapshot saved after this completed response.',
        icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l1.5-2h7L17 7h3v12H4Z"/><circle cx="12" cy="13" r="3"/></svg>',
        disabled: actionDisabled
      });
      snapshot.setAttribute('aria-haspopup', 'dialog');
      snapshot.setAttribute('aria-expanded', 'false');
      snapshot.addEventListener('click', () => {
        Promise.resolve(responseRecoveryActions.openSnapshots(snapshot)).catch(() => {});
      });
      actions.appendChild(snapshot);
    }
    control.appendChild(actions);
    if (notice) appendRevertPersistenceNote(control, notice);
  };

  function requestRevert(trigger) {
    const scope = Object.freeze({
      tabId: state.activeTabId,
      projectId: state.currentProjectId,
      sessionId: state.currentSession?.id,
      history: state.chatHistory
    });
    if (state.isStreaming || !state.activeTabOnTypst || !Number.isInteger(scope.tabId) || !scope.projectId || !scope.sessionId || state.currentSession?.projectId !== scope.projectId) {
      render('Open the matching Typst project and chat before reverting.');
      return;
    }
    openRevertConfirmation({
      trigger,
      checkpoint,
      onConfirm: () => executeRevert(scope),
      onError: error => render(error?.message || String(error))
    });
  }

  async function executeRevert(scope) {
      if (
        state.isStreaming || !state.activeTabOnTypst ||
        state.activeTabId !== scope.tabId ||
        state.currentProjectId !== scope.projectId ||
        state.currentSession?.id !== scope.sessionId ||
        state.currentSession?.projectId !== scope.projectId ||
        state.chatHistory !== scope.history
      ) {
        render('The active Typst project or chat changed. Open Revert again.');
        return;
      }
      const { tabId, projectId, sessionId, history } = scope;
      control.className = 'edit-revert-control response-recovery-control is-busy';
      control.dataset.revertState = 'busy';
      control.setAttribute('aria-busy', 'true');
      const actions = document.createElement('div');
      actions.className = 'response-recovery-actions';
      actions.appendChild(createResponseActionButton({
        className: 'edit-revert-button',
        label: 'Reverting…',
        title: 'Reverting later agent edits first, then this response.',
        icon: REVERT_ICONS.action,
        busy: true,
        disabled: true
      }));
      if (control.dataset.hasSnapshot === 'true') {
        actions.appendChild(createResponseActionButton({
          className: 'response-snapshot-button',
          label: 'Snapshot',
          title: 'Open the document snapshot saved after this completed response.',
          icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l1.5-2h7L17 7h3v12H4Z"/><circle cx="12" cy="13" r="3"/></svg>',
          disabled: true
        }));
      }
      control.replaceChildren(actions);
      try {
        const response = await bg({
          type: PROTOCOL.EDIT_CHECKPOINT_REVERT,
          checkpointId: checkpoint.id,
          tabId,
          projectId,
          sessionId
        });
        const checkpoints = normalizeCheckpointSummaries(
          response?.checkpoints,
          response?.checkpoint || { ...checkpoint, status: 'reverted' }
        );
        for (const summary of checkpoints) updateEditCheckpointInHistory(history, summary);
        checkpoint = checkpoints.find(summary => summary.id === checkpoint.id) || checkpoint;
        syncRenderedCheckpointControls(checkpoints);
        try {
          await bg({ type: PROTOCOL.SESSION_UPDATE, sessionId, messages: history });
        } catch (error) {
          appendRevertPersistenceNote(
            control,
            `Changes were reverted, but chat status was not saved: ${error?.message || String(error)}`
          );
        }
      } catch (error) {
        const completed = normalizeCheckpointSummaries(error?.details?.checkpoints);
        for (const summary of completed) updateEditCheckpointInHistory(history, summary);
        syncRenderedCheckpointControls(completed);
        let saveError = null;
        if (completed.length) {
          try {
            await bg({ type: PROTOCOL.SESSION_UPDATE, sessionId, messages: history });
          } catch (caught) {
            saveError = caught;
          }
        }
        render(error?.message || String(error));
        if (saveError) {
          appendRevertPersistenceNote(
            control,
            `Completed revert status was not saved to chat: ${saveError?.message || String(saveError)}`
          );
        }
      }
  }

  if (checkpoint) {
    checkpointControlRenderers.set(control, summary => {
      checkpoint = { ...checkpoint, ...summary };
      render();
    });
  }
  render();
  return control;
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

// =============================================================
// Tool blocks
// =============================================================

function toolCallLabel(name, args) {
  switch (name) {
    case 'read_file_structure': return 'Read file structure';
    case 'open_project_file': return `Open ${args.path || 'project file'}`;
    case 'read_document':    return 'Read document';
    case 'read_diagnostics': return 'Read diagnostics';
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
  if (name === 'read_file_structure') return 'wait for the Files sidebar, then scan its visible names and hierarchy';
  if (name === 'open_project_file') return `wait until ${args?.path || 'the requested file'} is open and text-accessible`;
  if (name === 'read_document') return args?.max_chars ? `max_chars=${args.max_chars}` : '(default size)';
  if (name === 'read_diagnostics') return `wait ${LIMITS.DIAGNOSTICS_SETTLE_DELAY_MS} ms for compilation, then read diagnostics`;
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

  if (live) {
    const scrollState = { follow: true };
    reasoningScrollStates.set(body, scrollState);
    body.addEventListener('scroll', () => {
      const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
      scrollState.follow = distanceFromBottom <= REASONING_FOLLOW_THRESHOLD_PX;
    }, { passive: true });
  }

  el.appendChild(header);
  el.appendChild(body);

  if (live) {
    el.classList.add('open');
  }

  header.addEventListener('click', () => el.classList.toggle('open'));
  updateReasoningMeta(el);
  return el;
}

function finishReasoningMutation(body) {
  const scrollState = reasoningScrollStates.get(body);
  if (scrollState?.follow) body.scrollTop = body.scrollHeight;
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

function scheduleStreamRender() {
  if (state.stream.renderFrame != null) return;
  state.stream.followBeforeRender = isNearBottom();
  state.stream.renderFrame = requestAnimationFrame(() => flushPendingRender());
}

export function flushPendingRender() {
  if (state.stream.renderFrame != null) cancelAnimationFrame(state.stream.renderFrame);
  state.stream.renderFrame = null;
  const follow = state.stream.followBeforeRender ?? isNearBottom();
  state.stream.followBeforeRender = null;
  if (state.stream.dirtyContent && state.stream.currentContentEl) {
    renderMarkdownInto(state.stream.currentContentEl, state.stream.currentText);
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

function ensureContentSegment() {
  // If a reasoning segment is active, finalize it before starting answer text
  // so the "Thinking" block visually closes once the answer begins streaming.
  if (state.stream.currentReasoningEl) {
    flushPendingRender();
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
  // Reasoning always precedes the next content/tool segment. If we were already
  // emitting answer text, close that text segment so the order is preserved.
  if (state.stream.currentContentEl) flushPendingRender();
  state.stream.currentContentEl = null;
  state.stream.currentText = '';
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
  flushPendingRender();
  const follow = isNearBottom();
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
  finishDomMutation(follow);
}

/**
 * Show a "waiting on the page" banner inside a tool block and surface Retry /
 * Skip buttons. Each action is correlated to the exact active run and call.
 */
export function markPreflightWaiting({ callId, name, missing, hint }) {
  const block = findToolBlock(callId);
  if (!block) return;

  const fileReturn = Array.isArray(missing) && missing.some(item => /^open file:/i.test(item));
  const status = block.querySelector('.tool-status');
  if (status) {
    status.className = 'tool-status tool-status-waiting';
    status.textContent = fileReturn && name === 'open_project_file' ? 'open file…' : fileReturn ? 'return to file…' : 'needs page…';
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
      const runId = state.activeRun?.runId;
      if (runId) bg({ type: PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE, runId, callId, action: 'retry' }).catch(() => {});
    });

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'tool-preflight-btn tool-preflight-skip';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => {
      const runId = state.activeRun?.runId;
      if (runId) bg({ type: PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE, runId, callId, action: 'cancel' }).catch(() => {});
    });

    actions.appendChild(retry);
    actions.appendChild(skip);
    banner.appendChild(actions);
    block.appendChild(banner);
  }

  banner.querySelector('.tool-preflight-msg').textContent = hint || 'Waiting for the typst.app page…';
  const retry = banner.querySelector('.tool-preflight-retry');
  if (retry) retry.textContent = fileReturn ? 'Check again' : 'Retry now';
  const missingRow = banner.querySelector('.tool-preflight-missing');
  if (missingRow) {
    missingRow.textContent = Array.isArray(missing) && missing.length > 0
      ? `${fileReturn ? 'Required' : 'Missing'}: ${missing.join(', ').replace(/^open file:\s*/i, '')}`
      : '';
  }
  finishDomMutation(isNearBottom());
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

export function markApprovalRequired({ runId, callId, name, effect, destination, arguments: argumentSummary, argumentChars, argumentsTruncated, preview, previewNotice }) {
  const block = findToolBlock(callId);
  if (!block || runId !== state.activeRun?.runId) return;
  const follow = isNearBottom();
  const status = block.querySelector('.tool-status');
  if (status) {
    status.className = 'tool-status tool-status-waiting';
    status.textContent = 'approval…';
  }
  block.querySelector('.tool-approval')?.remove();

  const banner = document.createElement('div');
  banner.className = 'tool-preflight tool-approval';
  const editorReview = effect === 'editor-write' && preview?.kind === 'unified-diff';
  if (editorReview) banner.classList.add('tool-edit-approval');
  const message = document.createElement('div');
  message.className = 'tool-preflight-msg';
  message.textContent = editorReview
    ? 'Review the proposed editor change before applying it.'
    : `${name || 'Tool'} requests ${effect === 'editor-write' ? 'an editor change' : 'an external call'}.`;
  const destinationRow = document.createElement('div');
  destinationRow.className = 'tool-preflight-missing';
  destinationRow.textContent = `Destination: ${destination || 'unknown'}`;
  const previewNoticeRow = document.createElement('div');
  previewNoticeRow.className = 'tool-edit-preview-notice';
  previewNoticeRow.textContent = String(previewNotice || '').slice(0, 500);
  const details = document.createElement('pre');
  details.className = 'tool-approval-arguments';
  details.textContent = String(argumentSummary || '').slice(0, 2000);
  const argumentDisclosure = document.createElement('details');
  argumentDisclosure.className = 'tool-approval-disclosure';
  const argumentSummaryRow = document.createElement('summary');
  argumentSummaryRow.textContent = argumentsTruncated
    ? `Tool arguments (showing 2,000 of ${Number(argumentChars).toLocaleString()} characters)`
    : `Tool arguments (${Number(argumentChars).toLocaleString()} characters)`;
  argumentDisclosure.append(argumentSummaryRow, details);
  const actions = document.createElement('div');
  actions.className = 'tool-preflight-actions';

  const choices = editorReview
    ? [
        ['Apply changes', 'approve_once', 'tool-preflight-retry'],
        ['Reject', 'deny', 'tool-preflight-skip']
      ]
    : [
        ['Approve once', 'approve_once', 'tool-preflight-retry'],
        ['Allow for run', 'allow_run', 'tool-preflight-retry'],
        ['Deny', 'deny', 'tool-preflight-skip']
      ];
  for (const [label, action, className] of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tool-preflight-btn ${className}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        await bg({ type: PROTOCOL.AI_TOOL_APPROVAL_RESOLVE, runId, callId, action });
        banner.remove();
        if (status) {
          status.className = action === 'deny' ? 'tool-status tool-status-err' : 'tool-status tool-status-pending';
          status.textContent = action === 'deny' ? (editorReview ? 'rejected' : 'denied') : (editorReview ? 'applying…' : 'running…');
        }
      } catch (error) {
        actions.querySelectorAll('button').forEach(item => { item.disabled = false; });
        message.textContent = `Could not submit approval: ${error?.message || String(error)}`;
      }
    });
    actions.appendChild(button);
  }
  banner.append(message, destinationRow);
  if (editorReview && previewNoticeRow.textContent) banner.appendChild(previewNoticeRow);
  if (editorReview) banner.appendChild(renderEditDiffPreview(preview));
  banner.append(argumentDisclosure, actions);
  block.appendChild(banner);
  finishDomMutation(follow);
}

function findToolBlock(callId) {
  const expected = String(callId ?? '');
  const findExact = root => {
    if (!root) return null;
    for (const block of root.querySelectorAll('[data-call-id]')) {
      if (block.dataset.callId === expected) return block;
    }
    return null;
  };
  const bodyEl = state.stream.bodyEl;
  return findExact(bodyEl) || findExact($('messages'));
}

export function handleToolResult(callId, name, result) {
  flushPendingRender();
  const follow = isNearBottom();
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
      const parserStatus = result.status_count ?? 0;
      if (!n) {
        status.textContent = 'clean';
      } else {
        const parts = [];
        if (err) parts.push(`${err} err`);
        if (warn) parts.push(`${warn} warn`);
        if (spell) parts.push(`${spell} spell`);
        if (parserStatus) parts.push(`${parserStatus} status`);
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
              : d?.kind === 'typst-status'
                ? 'STATUS'
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
  finishDomMutation(follow);
}

function clearRenderedSnapshotActions() {
  for (const button of document.querySelectorAll('.response-snapshot-button')) {
    const control = button.closest('.response-recovery-control');
    const actions = button.closest('.response-recovery-actions');
    if (control) control.dataset.hasSnapshot = 'false';
    button.remove();
    if (actions && actions.children.length === 0) control?.remove();
  }
}

export function finalizeStream(onSave, { responseStatus = 'incomplete' } = {}) {
  flushPendingRender();
  if (state.stream.messageEl) state.stream.messageEl.classList.remove('streaming');
  if (state.stream.currentReasoningEl) {
    state.stream.currentReasoningEl.classList.remove('open', 'is-live');
  }
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
