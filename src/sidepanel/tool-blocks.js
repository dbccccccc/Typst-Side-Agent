/** Tool-call blocks: labels, preflight banners, approval prompts, and result summaries. */
import { LIMITS } from '../shared/constants.js';
import { PROTOCOL } from '../shared/protocol.js';
import { renderEditDiffPreview } from './edit-diff.js';
import { state, bg } from './state.js';
import { $, finishDomMutation, iconElement, isNearBottom, svgIcon } from './chat-dom.js';

const TOOL_ICON = svgIcon(14, 2,
  '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94'
  + 'l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
);
const MAX_DIAGNOSTIC_ROWS = 8;

function toolCallLabel(name, args) {
  switch (name) {
    case 'read_file_structure': return 'Read file structure';
    case 'open_project_file': return `Open ${args.path || 'project file'}`;
    case 'read_document': return 'Read document';
    case 'read_diagnostics': return 'Read diagnostics';
    case 'replace_lines': return `Replace lines ${args.start_line}–${args.end_line}`;
    case 'insert_at_cursor': return 'Insert at cursor';
    case 'replace_selection': return 'Replace selection';
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

function setStatusBadge(status, className, text) {
  if (!status) return;
  status.className = `tool-status ${className}`;
  status.textContent = text;
}

export function renderToolBlock(tc, applied, result) {
  const el = document.createElement('div');
  el.className = 'tool-block';
  el.dataset.callId = tc.id;

  const header = document.createElement('div');
  header.className = 'tool-block-header';

  const label = document.createElement('div');
  label.className = 'tool-block-label';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-block-name';
  nameEl.textContent = toolCallLabel(tc.name, tc.args || {});
  label.append(iconElement('tool-block-icon', TOOL_ICON), nameEl);

  const status = document.createElement('span');
  if (!applied) setStatusBadge(status, 'tool-status-pending', 'running…');
  else if (result && result.ok === false) setStatusBadge(status, 'tool-status-err', 'failed');
  else setStatusBadge(status, 'tool-status-ok', 'done');

  header.append(label, status);
  el.appendChild(header);

  const detail = document.createElement('pre');
  detail.className = 'tool-block-detail';
  const preview = toolCallPreview(tc.name, tc.args || {});
  if (preview) detail.textContent = preview;
  el.appendChild(detail);

  header.addEventListener('click', () => detail.classList.toggle('show'));
  return el;
}

export function findToolBlock(callId) {
  const expected = String(callId ?? '');
  const findExact = root => {
    if (!root) return null;
    for (const block of root.querySelectorAll('[data-call-id]')) {
      if (block.dataset.callId === expected) return block;
    }
    return null;
  };
  return findExact(state.stream.bodyEl) || findExact($('messages'));
}

function resolvePreflight(callId, action) {
  const runId = state.activeRun?.runId;
  if (runId) bg({ type: PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE, runId, callId, action }).catch(() => {});
}

function createPreflightBanner(callId) {
  const banner = document.createElement('div');
  banner.className = 'tool-preflight';
  const msg = document.createElement('div');
  msg.className = 'tool-preflight-msg';
  const missingRow = document.createElement('div');
  missingRow.className = 'tool-preflight-missing';
  const actions = document.createElement('div');
  actions.className = 'tool-preflight-actions';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'tool-preflight-btn tool-preflight-retry';
  retry.textContent = 'Retry now';
  retry.addEventListener('click', () => resolvePreflight(callId, 'retry'));
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'tool-preflight-btn tool-preflight-skip';
  skip.textContent = 'Skip';
  skip.addEventListener('click', () => resolvePreflight(callId, 'cancel'));
  actions.append(retry, skip);
  banner.append(msg, missingRow, actions);
  return banner;
}

/**
 * Show a "waiting on the page" banner inside a tool block and surface Retry /
 * Skip buttons. Each action is correlated to the exact active run and call.
 */
export function markPreflightWaiting({ callId, name, missing, hint }) {
  const block = findToolBlock(callId);
  if (!block) return;

  const fileReturn = Array.isArray(missing) && missing.some(item => /^open file:/i.test(item));
  const statusText = fileReturn && name === 'open_project_file' ? 'open file…' : fileReturn ? 'return to file…' : 'needs page…';
  setStatusBadge(block.querySelector('.tool-status'), 'tool-status-waiting', statusText);

  let banner = block.querySelector('.tool-preflight');
  if (!banner) {
    banner = createPreflightBanner(callId);
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
  block.querySelector('.tool-preflight')?.remove();
  setStatusBadge(block.querySelector('.tool-status'), 'tool-status-pending', 'running…');
}

function approvalChoices(editorReview) {
  return editorReview
    ? [
        ['Apply changes', 'approve_once', 'tool-preflight-retry'],
        ['Reject', 'deny', 'tool-preflight-skip']
      ]
    : [
        ['Approve once', 'approve_once', 'tool-preflight-retry'],
        ['Allow for run', 'allow_run', 'tool-preflight-retry'],
        ['Deny', 'deny', 'tool-preflight-skip']
      ];
}

export function markApprovalRequired({
  runId, callId, name, effect, destination, arguments: argumentSummary, argumentChars, argumentsTruncated, preview, previewNotice
}) {
  const block = findToolBlock(callId);
  if (!block || runId !== state.activeRun?.runId) return;
  const follow = isNearBottom();
  const status = block.querySelector('.tool-status');
  setStatusBadge(status, 'tool-status-waiting', 'approval…');
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

  for (const [label, action, className] of approvalChoices(editorReview)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tool-preflight-btn ${className}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        await bg({ type: PROTOCOL.AI_TOOL_APPROVAL_RESOLVE, runId, callId, action });
        banner.remove();
        if (action === 'deny') setStatusBadge(status, 'tool-status-err', editorReview ? 'rejected' : 'denied');
        else setStatusBadge(status, 'tool-status-pending', editorReview ? 'applying…' : 'running…');
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

function diagnosticsSummary(result) {
  const n = Array.isArray(result.diagnostics) ? result.diagnostics.length : 0;
  if (!n) return { status: 'clean', detail: 'No diagnostics.' };
  const parts = [];
  if (result.error_count) parts.push(`${result.error_count} err`);
  if (result.warning_count) parts.push(`${result.warning_count} warn`);
  if (result.spelling_count) parts.push(`${result.spelling_count} spell`);
  if (result.status_count) parts.push(`${result.status_count} status`);
  const lines = result.diagnostics.slice(0, MAX_DIAGNOSTIC_ROWS).map((d, i) => {
    // Spelling rows come from a separate advisory layer and status rows are
    // extraction notices; tag them so they never blend into compiler output.
    const tag = d?.kind === 'spelling' ? 'SPELLING' : d?.kind === 'typst-status' ? 'STATUS' : (d?.severity || 'info').toUpperCase();
    const line = Number.isFinite(d?.line) ? `L${d.line}` : 'L?';
    const col = Number.isFinite(d?.column) ? `:${d.column}` : '';
    const msg = (d?.message || '').replace(/\s+/g, ' ').trim() || '(no message)';
    return `${i + 1}. [${tag}] ${line}${col} ${msg}`;
  });
  if (n > MAX_DIAGNOSTIC_ROWS) lines.push(`... and ${n - MAX_DIAGNOSTIC_ROWS} more`);
  return { status: parts.length ? parts.join(', ') : `${n} diag`, detail: lines.join('\n') };
}

function successStatusText(name, result) {
  if (name === 'read_document') return `${result.doc_chars ?? '?'} chars${result.truncated ? ' (truncated)' : ''}`;
  if (name === 'patch_document') {
    const applied = result.edits_applied ?? 0;
    const skipped = result.skipped_count ?? 0;
    return skipped ? `${applied} ok, ${skipped} skipped` : `${applied} applied`;
  }
  return 'done';
}

export function handleToolResult(callId, name, result, { flush = () => {} } = {}) {
  flush();
  const follow = isNearBottom();
  const block = findToolBlock(callId);
  if (!block) return;
  block.querySelector('.tool-preflight')?.remove();
  const status = block.querySelector('.tool-status');
  const detail = block.querySelector('.tool-block-detail');

  if (result?.ok) {
    if (name === 'read_diagnostics') {
      const summary = diagnosticsSummary(result);
      setStatusBadge(status, 'tool-status-ok', summary.status);
      if (detail) detail.textContent = summary.detail;
    } else {
      setStatusBadge(status, 'tool-status-ok', successStatusText(name, result));
    }
  } else {
    setStatusBadge(status, 'tool-status-err', (result?.error || 'failed').slice(0, 50));
  }

  for (const seg of state.stream.segments) {
    if (seg.type === 'tools' && seg.calls.find(c => c.id === callId)) seg.results[callId] = result;
  }
  finishDomMutation(follow);
}
