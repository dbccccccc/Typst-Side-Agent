import { LIMITS } from '../shared/constants.js';

/**
 * Minimal Model Context Protocol client (Streamable HTTP transport).
 *
 * Supports `tools/list` and `tools/call`. We open one POST per call, advertise
 * the JSON+SSE Accept set required by Streamable HTTP, and return either the
 * JSON body or the first SSE message that resolves the request id.
 */

let nextId = 1;

function buildHeaders(server) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };
  if (server.headers) {
    for (const [k, v] of Object.entries(server.headers)) {
      if (k && typeof v === 'string') headers[k] = v;
    }
  }
  return headers;
}

async function readResponseAsJsonRpc(resp, requestId) {
  const ct = (resp.headers.get('Content-Type') || '').toLowerCase();

  if (ct.includes('application/json')) {
    const data = await resp.json();
    return data;
  }

  if (ct.includes('text/event-stream')) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() || '';
      for (const evt of events) {
        const dataLines = evt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        try {
          const obj = JSON.parse(dataStr);
          if (obj?.id === requestId) {
            try { reader.cancel(); } catch { /* ignore */ }
            return obj;
          }
        } catch { /* skip malformed */ }
      }
      if (done) break;
    }
    throw new Error('MCP stream ended before response');
  }

  // Try to parse as JSON regardless of content-type.
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Unexpected MCP response (${resp.status}): ${text.slice(0, 200)}`); }
}

async function rpc(server, method, params, signal) {
  const requestId = nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), LIMITS.MCP_CALL_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const resp = await fetch(server.url, { method: 'POST', headers: buildHeaders(server), body, signal: ctrl.signal });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await readResponseAsJsonRpc(resp, requestId);
    if (data?.error) throw new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`);
    return data?.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function listMcpTools(server, signal) {
  const result = await rpc(server, 'tools/list', {}, signal);
  return Array.isArray(result?.tools) ? result.tools : [];
}

export async function callMcpTool(server, name, args, signal) {
  const result = await rpc(server, 'tools/call', { name, arguments: args || {} }, signal);
  // Per spec: { content: [{ type, text|... }], isError? }
  return result;
}

/** Render an MCP `result.content` array into a single string for the model. */
export function renderMcpContent(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const parts = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item) continue;
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else if (item.type === 'resource' && item.resource?.text) parts.push(String(item.resource.text));
      else parts.push(JSON.stringify(item));
    }
  } else if (typeof result === 'object') {
    parts.push(JSON.stringify(result));
  }
  return parts.join('\n');
}
