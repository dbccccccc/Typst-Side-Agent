import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { PROTOCOL, successResponse } from '../src/shared/protocol.js';

// The side panel modules address the real document, so give them the shipped
// markup inside a jsdom window before they are imported.
const html = await readFile(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'chrome-extension://fixture/src/sidepanel/index.html' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.HTMLElement = window.HTMLElement;
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
window.marked = marked;
window.DOMPurify = createDOMPurify(window);

const sent = [];
let respond = () => ({ ok: true });
globalThis.chrome = {
  runtime: {
    sendMessage: async message => {
      sent.push(message);
      return successResponse(message.requestId, respond(message), message.runId);
    }
  }
};

const chat = await import('../src/sidepanel/chat.js');
const { state, resetStream } = await import('../src/sidepanel/state.js');
chat.setupMarkdown();

const messagesEl = () => document.getElementById('messages');
const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });

function beginStream(runId = 'run-x') {
  state.chatHistory = [];
  chat.renderMessages();
  state.isStreaming = true;
  state.activeRun = { runId };
  resetStream();
  const { messageEl, bodyEl } = chat.createStreamingMessage();
  state.stream.messageEl = messageEl;
  state.stream.bodyEl = bodyEl;
  return bodyEl;
}

test('markdown renders sanitized DOM and neutralizes hostile content', () => {
  const hostile = [
    '# Title',
    '',
    '<img src="https://remote.example/x.png" onerror="alert(1)"> [bad](javascript:alert(1)) [cleartext](http://example.com)',
    '[ok](https://example.com "Example") ![pic](https://img.example/p.png) <script>alert(1)</script> `code`'
  ].join('\n');
  const host = document.createElement('div');
  host.appendChild(chat.renderMarkdownFragment(hostile));
  assert.ok(host.querySelector('h1'));
  assert.ok(host.querySelector('code'));
  assert.equal(host.querySelector('img, script, [onerror]'), null);
  assert.equal(host.querySelectorAll('a[href^="javascript:"], a[href^="http:"]').length, 0);
  assert.match(host.textContent, /bad/);
  const ok = host.querySelector('a[href="https://example.com"]');
  assert.equal(ok.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(ok.getAttribute('target'), '_blank');
  assert.equal(ok.getAttribute('title'), 'Example');
  const picture = host.querySelector('a[href="https://img.example/p.png"]');
  assert.equal(picture.textContent, 'Image: pic');
});

test('markdown falls back to inert plain text when the renderer libraries are unavailable', () => {
  const saved = window.marked;
  window.marked = null;
  try {
    const host = document.createElement('div');
    host.appendChild(chat.renderMarkdownFragment('<b>raw</b> **md**'));
    assert.equal(host.children.length, 0);
    assert.equal(host.textContent, '<b>raw</b> **md**');
  } finally {
    window.marked = saved;
  }
});

test('the empty state offers three suggestions that fill the composer', () => {
  state.chatHistory = [];
  chat.renderMessages();
  const suggestions = messagesEl().querySelectorAll('.empty-suggestion');
  assert.equal(suggestions.length, 3);
  const input = document.getElementById('user-input');
  input.disabled = false;
  let inputEvents = 0;
  input.addEventListener('input', () => { inputEvents += 1; }, { once: true });
  suggestions[1].click();
  assert.equal(input.value, suggestions[1].dataset.prompt);
  assert.equal(inputEvents, 1);
});

test('history renders attachments, ordered assistant segments, and one Snapshot action', () => {
  state.isStreaming = false;
  state.activeTabOnTypst = true;
  state.chatHistory = [
    {
      role: 'user',
      content: 'hello',
      sentAttachments: {
        selections: [{ text: 'sel text', fileLabel: 'main.typ' }],
        previews: [{ omitted: true, reason: 'too big' }, { dataUrl: 'data:image/png;base64,AAAA', thumbnail: true }]
      }
    },
    { role: 'assistant', content: 'first', responseStatus: 'complete', segments: [{ type: 'text', content: 'first' }] },
    { role: 'user', content: 'again' },
    {
      role: 'assistant',
      content: '**done**',
      responseStatus: 'complete',
      segments: [
        { type: 'reasoning', content: 'thinking' },
        { type: 'tools', calls: [{ id: 'c1', name: 'read_diagnostics', args: {} }], results: { c1: { ok: true, diagnostics: [] } } },
        { type: 'text', content: '**done**' }
      ]
    },
    { role: 'assistant', content: 'partial', responseStatus: 'incomplete', segments: [{ type: 'text', content: 'partial' }] }
  ];
  chat.renderMessages();
  const root = messagesEl();
  assert.equal(root.querySelectorAll('.msg-user').length, 2);
  assert.deepEqual([...root.querySelectorAll('.msg-user-pill')].map(pill => pill.textContent), [
    'Selection 1 · main.typ: sel text', 'Preview 1 not retained'
  ]);
  assert.equal(root.querySelectorAll('img.msg-user-thumb').length, 1);
  assert.equal(root.querySelectorAll('.response-snapshot-button').length, 1);
  const assistants = root.querySelectorAll('.msg-assistant');
  assert.ok(assistants[1].querySelector('.response-snapshot-button'), 'latest complete response offers Snapshot');
  assert.equal(assistants[2].querySelector('.response-snapshot-button'), null, 'incomplete response offers nothing');
  const children = [...assistants[1].querySelector('.msg-body').children].map(child => child.className.split(' ')[0]);
  assert.deepEqual(children, ['reasoning-block', 'tool-block', 'msg-content', 'edit-revert-control']);
  assert.equal(assistants[1].querySelector('.reasoning-title').textContent, 'Thought');
  assert.equal(assistants[1].querySelector('.tool-status').textContent, 'done');
  assert.equal(assistants[1].querySelector('.msg-content strong').textContent, 'done');
});

test('streaming keeps unfinished text inert, preserves segment order, and records the run id', () => {
  const bodyEl = beginStream('run-stream');
  chat.appendChunk('**bold');
  chat.appendChunk(' text**');
  chat.flushPendingRender();
  const content = bodyEl.querySelector('.msg-content');
  assert.equal(content.childNodes.length, 1);
  assert.equal(content.firstChild.nodeType, window.Node.TEXT_NODE);
  assert.equal(content.textContent, '**bold text**');

  chat.appendReasoning('hmm');
  assert.equal(content.querySelector('strong')?.textContent, 'bold text', 'closed text segment is rendered once');
  chat.flushPendingRender();
  const reasoning = bodyEl.querySelector('.reasoning-block');
  assert.ok(reasoning.classList.contains('is-live'));
  assert.equal(reasoning.querySelector('.reasoning-body').textContent, 'hmm');
  assert.equal(reasoning.querySelector('.reasoning-meta').textContent, '3 chars');

  chat.handleToolCalls([{ id: 'call-1', name: 'read_document', args: {} }]);
  assert.equal(reasoning.classList.contains('is-live'), false, 'tool calls close the thinking block');
  const block = bodyEl.querySelector('[data-call-id="call-1"]');
  assert.equal(block.querySelector('.tool-status').textContent, 'running…');
  chat.handleToolResult('call-1', 'read_document', { ok: true, doc_chars: 120, truncated: true });
  assert.equal(block.querySelector('.tool-status').textContent, '120 chars (truncated)');
  chat.handleToolResult('call-1', 'read_diagnostics', {
    ok: true, error_count: 1, diagnostics: [{ severity: 'error', line: 3, column: 2, message: 'Unknown variable' }]
  });
  assert.equal(block.querySelector('.tool-status').textContent, '1 err');
  assert.equal(block.querySelector('.tool-block-detail').textContent, '1. [ERROR] L3:2 Unknown variable');

  chat.appendChunk('Done.');
  let saved = 0;
  chat.finalizeStream(() => { saved += 1; }, { responseStatus: 'complete' });
  assert.equal(saved, 1);
  assert.equal(state.isStreaming, false);
  const entry = state.chatHistory.at(-1);
  assert.equal(entry.runId, 'run-stream');
  assert.equal(entry.responseStatus, 'complete');
  assert.equal(entry.content, '**bold text**Done.');
  assert.deepEqual(entry.segments.map(segment => segment.type), ['text', 'reasoning', 'tools', 'text']);
  assert.equal(entry.segments[2].results['call-1'].error_count, 1);
  assert.ok(bodyEl.querySelector('.response-snapshot-button'));
  assert.equal(document.getElementById('send-btn').classList.contains('is-stop'), false);
});

test('an empty stream leaves no assistant record behind', () => {
  const bodyEl = beginStream('run-empty');
  chat.finalizeStream(null, { responseStatus: 'incomplete' });
  assert.equal(bodyEl.isConnected, false);
  assert.equal(state.chatHistory.length, 0);
  chat.failStream('boom', () => {});
  assert.equal(state.isStreaming, false);
});

test('preflight and approval banners send actions correlated to the active run', async () => {
  const bodyEl = beginStream('run-approve');
  sent.length = 0;
  chat.handleToolCalls([{ id: 'call-2', name: 'replace_lines', args: { start_line: 1, end_line: 1, new_content: 'x' } }]);
  const block = bodyEl.querySelector('[data-call-id="call-2"]');
  assert.equal(block.querySelector('.tool-block-name').textContent, 'Replace lines 1–1');

  chat.markPreflightWaiting({ callId: 'call-2', name: 'replace_lines', missing: ['editor'], hint: 'Open the editor' });
  assert.equal(block.querySelector('.tool-status').textContent, 'needs page…');
  assert.equal(block.querySelector('.tool-preflight-msg').textContent, 'Open the editor');
  assert.equal(block.querySelector('.tool-preflight-missing').textContent, 'Missing: editor');
  block.querySelector('.tool-preflight-retry').click();
  await settle();
  assert.equal(sent.at(-1).type, PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE);
  assert.equal(sent.at(-1).runId, 'run-approve');
  assert.deepEqual(sent.at(-1).payload, { callId: 'call-2', action: 'retry' });

  chat.markPreflightWaiting({ callId: 'call-2', name: 'replace_lines', missing: ['open file: main.typ'], hint: 'Return to main.typ' });
  assert.equal(block.querySelector('.tool-status').textContent, 'return to file…');
  assert.equal(block.querySelector('.tool-preflight-missing').textContent, 'Required: main.typ');
  chat.markPreflightReady('call-2');
  assert.equal(block.querySelector('.tool-preflight'), null);
  assert.equal(block.querySelector('.tool-status').textContent, 'running…');

  const preview = {
    kind: 'unified-diff', fileLabel: 'main.typ', additions: 1, deletions: 1,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
      { kind: 'delete', oldLine: 1, newLine: null, text: 'old' },
      { kind: 'insert', oldLine: null, newLine: 1, text: 'x' }
    ] }]
  };
  const approval = {
    callId: 'call-2', name: 'replace_lines', identity: 'builtin:replace_lines', effect: 'editor-write',
    destination: 'originating Typst editor', arguments: '{}', argumentChars: 2, argumentsTruncated: false, preview
  };
  chat.markApprovalRequired({ ...approval, runId: 'another-run' });
  assert.equal(block.querySelector('.tool-approval'), null, 'approval for another run is ignored');
  chat.markApprovalRequired({ ...approval, runId: 'run-approve', previewNotice: 'Inline preview truncated.' });
  assert.deepEqual([...block.querySelectorAll('.tool-approval .tool-preflight-btn')].map(button => button.textContent), ['Apply changes', 'Reject']);
  assert.ok(block.querySelector('.tool-approval .edit-diff'));
  assert.equal(block.querySelector('.tool-edit-preview-notice').textContent, 'Inline preview truncated.');
  assert.equal(block.querySelector('.tool-status').textContent, 'approval…');
  block.querySelector('.tool-approval .tool-preflight-retry').click();
  await settle();
  assert.equal(sent.at(-1).type, PROTOCOL.AI_TOOL_APPROVAL_RESOLVE);
  assert.deepEqual(sent.at(-1).payload, { callId: 'call-2', action: 'approve_once' });
  assert.equal(block.querySelector('.tool-approval'), null);
  assert.equal(block.querySelector('.tool-status').textContent, 'applying…');

  chat.handleToolCalls([{ id: 'call-3', name: 'mcp__files_ab12cd__read_file_ef34gh', args: { path: 'x' } }]);
  const external = bodyEl.querySelector('[data-call-id="call-3"]');
  assert.equal(external.querySelector('.tool-block-name').textContent, 'MCP: files_ab12cd / read_file_ef34gh');
  chat.markApprovalRequired({
    runId: 'run-approve', callId: 'call-3', name: 'mcp__files_ab12cd__read_file_ef34gh', identity: 'mcp:files:read_file',
    effect: 'external', destination: 'https://mcp.example', arguments: '{"path":"x"}', argumentChars: 12, argumentsTruncated: false
  });
  assert.deepEqual([...external.querySelectorAll('.tool-approval .tool-preflight-btn')].map(button => button.textContent), [
    'Approve once', 'Allow for run', 'Deny'
  ]);
  external.querySelector('.tool-approval .tool-preflight-skip').click();
  await settle();
  assert.deepEqual(sent.at(-1).payload, { callId: 'call-3', action: 'deny' });
  assert.equal(external.querySelector('.tool-status').textContent, 'denied');
  chat.finalizeStream(null, { responseStatus: 'incomplete' });
});

test('revert opens an in-panel confirmation, calls the worker, and persists the reverted receipt', async () => {
  state.isStreaming = false;
  state.activeTabOnTypst = true;
  state.activeTabId = 7;
  state.currentProjectId = 'project';
  state.currentSession = { id: 'session', projectId: 'project' };
  const receipt = { id: 'edit-1', status: 'applied', fileLabel: 'main.typ', createdAt: 1 };
  state.chatHistory = [{
    role: 'assistant', content: 'edited', responseStatus: 'complete',
    segments: [{ type: 'tools', calls: [{ id: 'e1', name: 'search_replace', args: {} }], results: { e1: { ok: true, editCheckpoint: receipt } } }]
  }];
  chat.renderMessages();
  const control = document.querySelector('.edit-revert-control');
  assert.equal(control.dataset.revertState, 'available');
  const layer = document.getElementById('revert-dialog-layer');
  const trigger = control.querySelector('.edit-revert-button');
  trigger.click();
  assert.equal(layer.classList.contains('hidden'), false);
  assert.equal(layer.dataset.checkpointId, 'edit-1');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(document.getElementById('revert-dialog-subtitle').textContent, 'main.typ');

  document.getElementById('revert-dialog-cancel').click();
  assert.equal(layer.classList.contains('hidden'), true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  trigger.click();
  sent.length = 0;
  respond = message => message.type === PROTOCOL.EDIT_CHECKPOINT_REVERT
    ? { ok: true, checkpoint: { ...receipt, status: 'reverted' }, checkpoints: [{ ...receipt, status: 'reverted' }], revertedCount: 1 }
    : { ok: true };
  document.getElementById('revert-dialog-confirm').click();
  for (let i = 0; i < 4; i++) await settle();
  respond = () => ({ ok: true });

  const revertRequest = sent.find(message => message.type === PROTOCOL.EDIT_CHECKPOINT_REVERT);
  assert.deepEqual(revertRequest.payload, { checkpointId: 'edit-1', tabId: 7, projectId: 'project', sessionId: 'session' });
  const update = sent.find(message => message.type === PROTOCOL.SESSION_UPDATE);
  assert.equal(update.payload.sessionId, 'session');
  assert.equal(update.payload.messages[0].segments[0].results.e1.editCheckpoint.status, 'reverted');
  assert.equal(layer.classList.contains('hidden'), true);
  assert.equal(control.dataset.revertState, 'success');
  assert.match(control.textContent, /Changes reverted/);
  assert.equal(chat.latestEditCheckpoint(state.chatHistory[0]).status, 'reverted');
});

test('a revert that the worker rejects shows the error and offers a retry', async () => {
  state.chatHistory = [{
    role: 'assistant', content: 'edited', responseStatus: 'complete',
    segments: [{ type: 'tools', calls: [{ id: 'e2', name: 'patch_document', args: {} }], results: {
      e2: { ok: true, editCheckpoint: { id: 'edit-2', status: 'applied', fileLabel: 'Current Typst document', createdAt: 2 } }
    } }]
  }];
  chat.renderMessages();
  const control = document.querySelector('.edit-revert-control');
  control.querySelector('.edit-revert-button').click();
  assert.equal(document.getElementById('revert-dialog-subtitle').textContent, 'the current Typst document');
  const original = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async () => { throw Object.assign(new Error('Document changed.'), { code: 'EDIT_REVERT_CONFLICT' }); };
  try {
    document.getElementById('revert-dialog-confirm').click();
    for (let i = 0; i < 4; i++) await settle();
  } finally {
    globalThis.chrome.runtime.sendMessage = original;
  }
  assert.equal(control.dataset.revertState, 'error');
  assert.equal(control.querySelector('.edit-revert-button').textContent, 'Try revert again');
  assert.match(control.querySelector('.edit-revert-note').textContent, /Document changed/);
});
