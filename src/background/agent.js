import { LIMITS, TYPST_APP_PREFIX, isReasoningEffortDefault } from '../shared/constants.js';
import { BUILTIN_TOOLS, PAGE_TOOL_NAMES, customToolToSpec, mcpToolToSpec } from './tools.js';
import { buildSystemMessage, buildMessages, modelReasoningReplayEnabled } from './context.js';
import { loadCustomTools, loadMcpServers } from './storage.js';
import { listMcpTools, callMcpTool, renderMcpContent } from './mcp.js';
import { listDocTopics, readDocTopic } from './docs.js';

let activeController = null;

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Tool preflight ----------
//
// Some tools depend on specific parts of the typst.app DOM being mounted
// (editor panel, "Improve" sidebar, selection, …). Before we execute one of
// these tools we probe the page; if the required capability is missing we
// pause the loop, tell the side panel what's needed, and resume once the user
// has opened the relevant panel and clicked Retry — or we skip the call with
// a helpful error so the model can try a different approach.
const TOOL_PREFLIGHT = {
  read_document: {
    caps: ['editor'],
    hint: 'Open a Typst (.typ) file in the typst.app editor so the source is visible.'
  },
  read_diagnostics: {
    caps: ['editor', 'improvePanel'],
    hint: 'Open the "Improve" panel in typst.app (left sidebar) so compiler diagnostics are visible.'
  },
  replace_lines: {
    caps: ['editor'],
    hint: 'Open the typst.app editor for the file you want to edit.'
  },
  search_replace: {
    caps: ['editor'],
    hint: 'Open the typst.app editor for the file you want to edit.'
  },
  patch_document: {
    caps: ['editor'],
    hint: 'Open the typst.app editor for the file you want to edit.'
  },
  insert_at_cursor: {
    caps: ['editor'],
    hint: 'Click inside the typst.app editor so the cursor is positioned where you want to insert.'
  },
  replace_selection: {
    caps: ['editor', 'selection'],
    hint: 'Select the text to replace in the typst.app editor, then click Retry.'
  }
};

// Per-callId promise used to interrupt the preflight poll when the user clicks
// Retry / Skip in the side panel.
const preflightWaiters = new Map();

export function resolvePreflight(callId, action) {
  const w = preflightWaiters.get(callId);
  if (w) w.resolve(action);
}

async function probePageCapabilities() {
  try {
    const r = await forwardToTab({ type: 'GET_PROBE' });
    if (!r || r.error) return { ok: false, error: r?.error || 'No response from page' };
    return {
      ok: true,
      editor: !!r.editor,
      selection: !!r.selection,
      typstCanvas: !!r.typstCanvas,
      previewImage: !!r.previewImage,
      improvePanel: !!r.improvePanel
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function waitForCapabilities(tc, controller) {
  const spec = TOOL_PREFLIGHT[tc.name];
  if (!spec) return { ok: true };

  const POLL_MS = 1500;
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const start = Date.now();
  let announced = false;

  while (true) {
    if (controller.signal.aborted) return { ok: false, error: 'Aborted by user' };

    const probe = await probePageCapabilities();
    const missing = probe.ok ? spec.caps.filter(cap => !probe[cap]) : spec.caps.slice();
    if (missing.length === 0) {
      if (announced) broadcast({ type: 'AI_TOOL_PREFLIGHT_READY', callId: tc.id });
      return { ok: true };
    }

    const effectiveHint = probe.ok
      ? spec.hint
      : `Switch to the typst.app tab and try again (${probe.error}).`;

    broadcast({
      type: 'AI_TOOL_PREFLIGHT_WAITING',
      callId: tc.id,
      name: tc.name,
      missing,
      hint: effectiveHint
    });
    announced = true;

    if (Date.now() - start > MAX_WAIT_MS) {
      return { ok: false, error: `Preflight timed out after 5 min. ${effectiveHint}` };
    }

    const action = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        preflightWaiters.delete(tc.id);
        resolve('tick');
      }, POLL_MS);
      preflightWaiters.set(tc.id, {
        resolve: (a) => {
          clearTimeout(timer);
          preflightWaiters.delete(tc.id);
          resolve(a);
        }
      });
    });

    if (controller.signal.aborted) return { ok: false, error: 'Aborted by user' };
    if (action === 'cancel') {
      return { ok: false, error: `User skipped this tool call. ${effectiveHint}` };
    }
    // 'retry' or 'tick' -> fall through and re-probe
  }
}

async function getTypstTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(TYPST_APP_PREFIX)) {
    throw new Error('No active typst.app tab');
  }
  return tab;
}

async function forwardToTab(payload) {
  const tab = await getTypstTab();
  return chrome.tabs.sendMessage(tab.id, payload);
}

// ---------- Tool execution ----------

async function executeReadDocument(args) {
  const ctx = await forwardToTab({ type: 'GET_EDITOR_CONTEXT' });
  if (ctx?.error) return { ok: false, error: ctx.error };

  const numbered = ctx.numberedFullText || '';
  // `numberedFullText` is exactly one "N|..." line per source line, joined
  // with '\n', so splitting on '\n' maps directly to source line numbers.
  const numberedLines = numbered.length > 0 ? numbered.split('\n') : [];
  const totalLines = numberedLines.length || (ctx.fullText || '').split('\n').length;

  const parseLine = v => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : NaN;
  };
  const rawStart = parseLine(args?.start_line);
  const rawEnd = parseLine(args?.end_line);
  if (Number.isNaN(rawStart) || Number.isNaN(rawEnd)) {
    return { ok: false, error: 'start_line and end_line must be integers' };
  }
  const hasRange = rawStart != null || rawEnd != null;

  const requestedChars = args?.max_chars != null ? Number(args.max_chars) : LIMITS.DEFAULT_READ_DOC_CHARS;
  const charCap = Math.min(
    Math.max(Number.isFinite(requestedChars) ? requestedChars : LIMITS.DEFAULT_READ_DOC_CHARS, 4000),
    LIMITS.MAX_READ_DOC_TOOL_CHARS
  );

  let startLine;
  let endLine;
  let body;

  if (hasRange && totalLines > 0) {
    let start = rawStart != null ? rawStart : 1;
    let end = rawEnd != null ? rawEnd : totalLines;
    if (start < 1) start = 1;
    if (end < start) end = start;
    start = Math.min(start, totalLines);
    end = Math.min(end, totalLines);
    startLine = start;
    endLine = end;
    body = numberedLines.slice(start - 1, end).join('\n');
  } else {
    startLine = totalLines > 0 ? 1 : 0;
    endLine = totalLines;
    body = numbered;
  }

  let truncated = false;
  if (body.length > charCap) {
    body = body.slice(0, charCap);
    truncated = true;
    // Recompute endLine based on how many full "N|..." lines survived the cap,
    // so the caller knows exactly where to resume.
    const survived = body.split('\n');
    // Drop a trailing partial line (no newline after it) so we only report
    // whole lines in the response range.
    if (survived.length > 1) survived.pop();
    endLine = startLine + Math.max(0, survived.length - 1);
    body = survived.join('\n');
  }

  return {
    ok: true,
    truncated,
    doc_chars: ctx.docLength,
    approx_line_count: totalLines,
    cursor_line: ctx.cursorLine,
    cursor_column: ctx.cursorColumn,
    start_line: startLine,
    end_line: endLine,
    numbered_document: body + (truncated ? '\n... (truncated — call read_document again with start_line=' + (endLine + 1) + ' to continue)' : ''),
    workspace: ctx.workspace || null
  };
}

async function executeReadDiagnostics(args) {
  const raw = args?.delay_ms;
  const delay = raw != null ? Number(raw) : 0;
  const clamped = Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 4000) : 0;
  if (clamped > 0) await sleep(clamped);
  const r = await forwardToTab({ type: 'GET_DIAGNOSTICS' });
  const diagnostics = r?.diagnostics || [];
  const isSpelling = d => d?.kind === 'spelling';
  return {
    ok: !r?.error,
    delay_ms: clamped,
    error: r?.error || null,
    diagnostics,
    // Counts are disjoint: an entry is counted in exactly one bucket. Spelling
    // is its own bucket (advisory suggestions from typst.app's spell layer)
    // and is NOT folded into warning_count, so the model can tell "fix me
    // first" compiler output apart from "maybe rephrase".
    error_count: diagnostics.filter(d => d.severity === 'error' && !isSpelling(d)).length,
    warning_count: diagnostics.filter(d => d.severity === 'warning' && !isSpelling(d)).length,
    spelling_count: diagnostics.filter(isSpelling).length
  };
}

async function executeReadTypstDocs(args) {
  const topic = args?.topic;
  if (topic == null || String(topic).trim() === '') {
    return {
      ok: true,
      topics: listDocTopics(),
      usage: 'Call read_typst_docs again with {"topic": "<id>"} to read that topic in full.'
    };
  }
  return readDocTopic(topic);
}

async function executePageTool(name, args, callId) {
  const resp = await forwardToTab({ type: 'EXECUTE_TOOL', toolName: name, args, callId });
  return resp?.result || resp || { ok: false, error: 'No response from page' };
}

async function executeCustomTool(tool, args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITS.CUSTOM_TOOL_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json', ...(tool.headers || {}) };
    const resp = await fetch(tool.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool: tool.name, arguments: args || {} }),
      signal: ctrl.signal
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, body: parsed };
    return { ok: true, result: parsed };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function executeMcpTool(server, toolName, args) {
  try {
    const result = await callMcpTool(server, toolName, args);
    if (result?.isError) return { ok: false, error: renderMcpContent(result) || 'MCP tool error' };
    return { ok: true, content: renderMcpContent(result), raw: result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ---------- MCP tool discovery ----------

/**
 * Try to list tools for every enabled MCP server. Failures are isolated per
 * server so one broken endpoint does not block the agent.
 */
async function discoverMcpToolset() {
  const servers = await loadMcpServers();
  const enabled = servers.filter(s => s.enabled !== false);
  const out = [];
  await Promise.all(enabled.map(async server => {
    try {
      const tools = await listMcpTools(server);
      out.push({ server, tools });
    } catch (e) {
      out.push({ server, tools: [], error: e.message || String(e) });
    }
  }));
  return out;
}

// ---------- Tool ordering ----------

/**
 * Run read_diagnostics last (so it sees the effects of edits). Apply
 * line-range edits bottom-to-top so earlier edits do not invalidate later
 * line numbers.
 */
export function sortToolCallsForExecution(toolCalls) {
  const checks = toolCalls.filter(t => t.name === 'read_diagnostics');
  const rest = toolCalls.filter(t => t.name !== 'read_diagnostics');
  rest.sort((a, b) => {
    const aLine = a.name === 'replace_lines' ? (a.parsedArgs?.start_line ?? 0) : 0;
    const bLine = b.name === 'replace_lines' ? (b.parsedArgs?.start_line ?? 0) : 0;
    return bLine - aLine;
  });
  return [...rest, ...checks];
}

// ---------- One streaming round ----------

/**
 * Pull reasoning text out of an SSE delta, regardless of which dialect the
 * provider speaks.
 *
 * Known shapes:
 *   - `delta.reasoning_content`        DeepSeek-R1, Qwen-QwQ, Moonshot Kimi-K2
 *   - `delta.reasoning`                OpenRouter (string), some Together routes
 *   - `delta.reasoning.content`        Newer OpenRouter / OpenAI-compat servers
 *   - `delta.thinking`                 A few llama.cpp / vLLM proxies
 */
export function extractReasoningChunk(delta) {
  if (!delta) return '';
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (delta.reasoning && typeof delta.reasoning.content === 'string') return delta.reasoning.content;
  if (typeof delta.thinking === 'string') return delta.thinking;
  return '';
}

/** Strip `<think>…</think>` blocks that some providers inline into `content`. */
export function splitInlineThink(buf) {
  const out = { reasoning: '', content: '', remainder: '' };
  let i = 0;
  while (i < buf.length) {
    const open = buf.indexOf('<think>', i);
    if (open === -1) { out.content += buf.slice(i); i = buf.length; break; }
    out.content += buf.slice(i, open);
    const close = buf.indexOf('</think>', open + 7);
    if (close === -1) { out.remainder = buf.slice(open); break; }
    out.reasoning += buf.slice(open + 7, close);
    i = close + 8;
  }
  return out;
}

async function streamOneRound(url, apiKey, modelId, messages, tools, controller, modelConfig) {
  const body = { model: modelId, stream: true, messages, tools };
  const effort = (modelConfig?.reasoningEffort || '').trim();
  if (effort && !isReasoningEffortDefault(effort)) body.reasoning_effort = effort;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let content = '';
  let reasoning = '';
  let inlineThinkBuf = '';
  const toolAccum = {};

  function emitContent(text) {
    if (!text) return;
    content += text;
    broadcast({ type: 'AI_STREAM_CHUNK', text });
  }

  function emitReasoning(text) {
    if (!text) return;
    reasoning += text;
    broadcast({ type: 'AI_STREAM_REASONING', text });
  }

  function processSseLine(line) {
    if (!line || !line.startsWith('data: ')) return 'continue';
    const data = line.slice(6);
    if (data === '[DONE]') return 'done';
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta;

      const reasoningChunk = extractReasoningChunk(delta);
      if (reasoningChunk) emitReasoning(reasoningChunk);

      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        // Some open-source models inline `<think>…</think>` into content. Route
        // those segments to the reasoning channel so they are not shown as the
        // final answer (and not echoed back as assistant `content` next round).
        inlineThinkBuf += delta.content;
        if (inlineThinkBuf.includes('<think>')) {
          const split = splitInlineThink(inlineThinkBuf);
          emitContent(split.content);
          emitReasoning(split.reasoning);
          inlineThinkBuf = split.remainder;
        } else {
          emitContent(inlineThinkBuf);
          inlineThinkBuf = '';
        }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolAccum[idx]) toolAccum[idx] = { id: '', name: '', arguments: '' };
          if (tc.id) toolAccum[idx].id = tc.id;
          if (tc.function?.name) toolAccum[idx].name = tc.function.name;
          if (tc.function?.arguments) toolAccum[idx].arguments += tc.function.arguments;
        }
      }
    } catch { /* ignore parse errors */ }
    return 'continue';
  }

  outer: while (true) {
    const { value, done } = await reader.read();
    sseBuffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = sseBuffer.split(/\r?\n/);
    sseBuffer = lines.pop() || '';
    for (const raw of lines) {
      if (controller.signal.aborted) break outer;
      if (processSseLine(raw.trim()) === 'done') break outer;
    }
    if (done) break;
  }
  const trailing = sseBuffer.trim();
  if (trailing) processSseLine(trailing);
  // Flush anything left in the inline-think buffer that never got a closing tag.
  if (inlineThinkBuf) {
    if (inlineThinkBuf.startsWith('<think>')) emitReasoning(inlineThinkBuf.slice(7));
    else emitContent(inlineThinkBuf);
  }

  const toolCalls = Object.values(toolAccum)
    .filter(tc => tc.name)
    .map(tc => {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.arguments); } catch { /* ignore */ }
      return { id: tc.id, name: tc.name, rawArgs: tc.arguments, parsedArgs };
    });

  return {
    content: content || null,
    reasoning: reasoning || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null
  };
}

/** DeepSeek-style APIs require `reasoning_content` on assistant+tool_calls turns when thinking is on. */
function attachReasoningContentToAssistantTurn(msg, reasoning, modelConfig) {
  const think = modelReasoningReplayEnabled(modelConfig);
  const hasText = typeof reasoning === 'string' && reasoning.length > 0;
  if (hasText) {
    msg.reasoning_content = reasoning;
    return;
  }
  if (think && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    msg.reasoning_content = '';
  }
}

// ---------- Public entry ----------

export function abortActiveStream() {
  if (activeController) activeController.abort();
  // Unblock any pending preflight waits so the loop can exit promptly.
  for (const [, waiter] of preflightWaiters) waiter.resolve('cancel');
  preflightWaiters.clear();
}

export async function handleStreamStart(msg) {
  const settings = msg.settings || {};
  const modelConfig = msg.modelConfig || (settings.models?.find(m => m.id === settings.activeModelId) ?? settings.models?.[0]);
  if (!modelConfig) throw new Error('No model configured. Add a model in Settings.');

  const apiBaseUrl = (modelConfig.apiBaseUrl || '').trim();
  const apiKey = (modelConfig.apiKey || '').trim();
  const modelId = (modelConfig.modelId || '').trim();
  if (!apiBaseUrl || !apiKey || !modelId) {
    throw new Error('Active model is missing base URL, API key, or model ID.');
  }

  const [customTools, mcpDiscovered] = await Promise.all([
    loadCustomTools(),
    discoverMcpToolset()
  ]);
  const enabledCustomTools = customTools.filter(t => t.enabled !== false);

  // Index MCP tools by namespaced name so we can route calls.
  const mcpToolIndex = new Map(); // name -> { server, tool }
  const mcpToolSpecs = [];
  const mcpServerSummaries = [];
  for (const entry of mcpDiscovered) {
    const summary = { id: entry.server.id, name: entry.server.name, toolNames: entry.tools.map(t => t.name), error: entry.error || null };
    mcpServerSummaries.push(summary);
    for (const tool of entry.tools) {
      const spec = mcpToolToSpec(entry.server.id, entry.server.name, tool);
      mcpToolSpecs.push(spec);
      mcpToolIndex.set(spec.function.name, { server: entry.server, tool });
    }
  }

  const tools = [
    ...BUILTIN_TOOLS,
    ...enabledCustomTools.map(customToolToSpec),
    ...mcpToolSpecs
  ];

  const systemMessage = buildSystemMessage({
    settings,
    attachments: msg.attachments || {},
    modelConfig,
    customTools: enabledCustomTools,
    mcpServers: mcpServerSummaries
  });

  const conversationMessages = buildMessages({
    systemMessage,
    attachments: msg.attachments || {},
    modelConfig,
    chatMessages: msg.messages,
    maxHistoryMessages: settings.maxHistoryMessages || 40
  });

  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;

  const url = apiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

  try {
    for (let round = 0; round < LIMITS.MAX_TOOL_ROUNDS; round++) {
      if (controller.signal.aborted) break;

      const { content, toolCalls, reasoning } = await streamOneRound(url, apiKey, modelId, conversationMessages, tools, controller, modelConfig);
      if (!toolCalls) break;

      broadcast({
        type: 'AI_TOOL_CALLS',
        calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: tc.parsedArgs }))
      });

      const assistantTurn = {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.rawArgs }
        }))
      };
      attachReasoningContentToAssistantTurn(assistantTurn, reasoning, modelConfig);
      conversationMessages.push(assistantTurn);

      const ordered = sortToolCallsForExecution(toolCalls);
      const results = {};
      for (const tc of ordered) {
        if (controller.signal.aborted) break;
        const result = await executeToolDispatch(tc, { customTools: enabledCustomTools, mcpToolIndex, controller });
        results[tc.id] = result;
        broadcast({ type: 'AI_TOOL_RESULT', callId: tc.id, name: tc.name, result });
      }

      for (const tc of toolCalls) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(results[tc.id] || { ok: false, error: 'Not executed' })
        });
      }
    }

    broadcast({ type: 'AI_STREAM_DONE' });
    return { ok: true };
  } catch (e) {
    if (controller.signal.aborted) {
      broadcast({ type: 'AI_STREAM_DONE' });
      return { ok: true };
    }
    broadcast({ type: 'AI_STREAM_ERROR', error: e.message });
    return { ok: false, error: e.message };
  } finally {
    if (activeController === controller) activeController = null;
  }
}

async function executeToolDispatch(tc, { customTools, mcpToolIndex, controller }) {
  const name = tc.name;
  try {
    if (TOOL_PREFLIGHT[name] && controller) {
      const pre = await waitForCapabilities(tc, controller);
      if (!pre.ok) return { ok: false, error: pre.error };
    }
    if (name === 'read_document') return await executeReadDocument(tc.parsedArgs || {});
    if (name === 'read_diagnostics') return await executeReadDiagnostics(tc.parsedArgs || {});
    if (name === 'read_typst_docs') return await executeReadTypstDocs(tc.parsedArgs || {});
    if (PAGE_TOOL_NAMES.has(name)) return await executePageTool(name, tc.parsedArgs || {}, tc.id);

    const custom = customTools.find(t => t.name === name);
    if (custom) return await executeCustomTool(custom, tc.parsedArgs || {});

    const mcp = mcpToolIndex.get(name);
    if (mcp) return await executeMcpTool(mcp.server, mcp.tool.name, tc.parsedArgs || {});

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ---------- Session title generation ----------

export function sanitizeTitle(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  // Strip surrounding quotes/backticks and a trailing period if any.
  t = t.replace(/^["'`\s]+|["'`\s]+$/g, '');
  t = t.replace(/[.!?]+$/, '');
  // Collapse whitespace and cap length.
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.slice(0, 60).trimEnd() + '…';
  return t;
}

function summarizeMessagesForTitle(messages) {
  if (!Array.isArray(messages)) return '';
  const bits = [];
  for (const m of messages.slice(0, 6)) {
    if (typeof m?.content !== 'string' || !m.content.trim()) continue;
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : null;
    if (!role) continue;
    const body = m.content.replace(/\s+/g, ' ').trim().slice(0, 400);
    bits.push(`${role}: ${body}`);
    if (bits.length >= 4) break;
  }
  return bits.join('\n');
}

/**
 * Generate a short (≤ 6 word) title for a chat session using a lightweight
 * non-streaming call against the user-configured auto-name model.
 *
 * @param {Object} modelConfig {apiBaseUrl, apiKey, modelId}
 * @param {Array}  messages    chat history so far
 */
export async function generateSessionTitle(modelConfig, messages) {
  if (!modelConfig?.apiBaseUrl || !modelConfig?.apiKey || !modelConfig?.modelId) {
    throw new Error('Auto-name model is not fully configured');
  }
  const summary = summarizeMessagesForTitle(messages);
  if (!summary) throw new Error('Not enough conversation to name');

  const url = modelConfig.apiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: modelConfig.modelId,
    stream: false,
    temperature: 0.2,
    max_tokens: 24,
    messages: [
      {
        role: 'system',
        content:
          'You name chat sessions. Read the conversation and reply with a concise ' +
          'title (≤ 4 words, Title Case). No quotes, no punctuation at the end, no emoji, ' +
          'no "Chat about". Just the title.'
      },
      { role: 'user', content: summary }
    ]
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${modelConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    const title = sanitizeTitle(raw);
    if (!title) throw new Error('Empty title from model');
    return title;
  } finally {
    clearTimeout(timer);
  }
}
