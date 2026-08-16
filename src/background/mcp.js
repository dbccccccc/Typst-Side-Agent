import { LIMITS } from '../shared/constants.js';
import { createOperationSignal, isAbortError, raceWithSignal } from '../shared/abort.js';
import { readResponseTextBounded } from '../shared/bounded-response.js';
import { validateEndpointUrl } from '../shared/endpoint-policy.js';
import { validateToolSchema } from '../shared/tool-validation.js';
import { stableHash } from '../shared/trust-policy.js';

/**
 * Internal MCP 2026-07-28 Streamable HTTP transport.
 *
 * The current protocol is stateless: every request carries version/client
 * metadata, `MCP-Protocol-Version`, and `Mcp-Method`; tool calls also carry
 * `Mcp-Name` and any validated `x-mcp-header` parameters. The module remains
 * far below the 500 KiB SDK size gate and is fixture-tested, so no SDK/browser
 * bundling path is needed. Legacy handshake-based revisions are deliberately
 * rejected rather than approximated with direct RPC calls.
 *
 * Specification: https://modelcontextprotocol.io/specification/2026-07-28/
 */

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const CLIENT_NAME = 'typst-side-agent';
const DEFAULT_CACHE_MS = 60_000;
const MAX_CACHE_MS = 60 * 60 * 1000;
const discoveryCache = new Map();
let nextId = 1;
let adapters = defaults();

function defaults() {
  return {
    fetchImpl: (...args) => fetch(...args),
    now: () => Date.now(),
    setTimeoutImpl: (...args) => setTimeout(...args),
    clearTimeoutImpl: id => clearTimeout(id),
    clientVersion: () => globalThis.chrome?.runtime?.getManifest?.().version || '0.0.0'
  };
}

export function configureMcpAdapters(overrides = {}) {
  adapters = { ...defaults(), ...overrides };
  discoveryCache.clear();
  nextId = 1;
}

export function resetMcpAdapters() {
  configureMcpAdapters();
}

export function invalidateMcpCache(serverId = null) {
  if (!serverId) discoveryCache.clear();
  else for (const [key, value] of discoveryCache) if (value.serverId === serverId) discoveryCache.delete(key);
}

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: CLIENT_NAME, version: adapters.clientVersion() },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

function buildHeaders(server, method, params, parameterHeaders = []) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'Mcp-Method': method
  };
  if (method === 'tools/call') headers['Mcp-Name'] = encodeHeaderValue(params.name);

  const protectedNames = new Set(Object.keys(headers).map(key => key.toLowerCase()));
  for (const [key, value] of Object.entries(server.headers || {})) {
    if (!key || typeof value !== 'string') continue;
    if (protectedNames.has(key.toLowerCase()) || key.toLowerCase().startsWith('mcp-param-')) {
      const error = new Error(`Configured header "${key}" conflicts with an MCP protocol header.`);
      error.code = 'MCP_HEADER_CONFLICT';
      throw error;
    }
    headers[key] = value;
  }
  if (method === 'tools/call') {
    for (const item of parameterHeaders) {
      headers[`Mcp-Param-${item.name}`] = encodeHeaderValue(item.value);
    }
  }
  return headers;
}

export function collectMcpParameterHeaders(schema, args) {
  return extractMcpParameterHeaders(schema, args).headers;
}

/** Move x-mcp-header values out of a cloned JSON argument object. */
export function extractMcpParameterHeaders(schema, args) {
  const headers = [];
  const jsonArguments = cloneJson(args || {});
  function visit(node, source, target, reachable) {
    if (!node || typeof node !== 'object') return;
    if (node['x-mcp-header'] && reachable && source != null) {
      if (!['string', 'number', 'boolean'].includes(typeof source) || (node.type === 'integer' && !Number.isSafeInteger(source))) {
        const error = new Error(`Invalid value for x-mcp-header ${node['x-mcp-header']}.`);
        error.code = 'INVALID_MCP_HEADER_VALUE';
        throw error;
      }
      headers.push({ name: node['x-mcp-header'], value: String(source) });
      return true;
    }
    for (const [key, child] of Object.entries(node.properties || {})) {
      if (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, key)) {
        if (visit(child, source[key], target?.[key], reachable)) delete target[key];
      }
    }
    return false;
  }
  visit(schema, args || {}, jsonArguments, true);
  return { headers, arguments: jsonArguments };
}

export function encodeHeaderValue(value) {
  const text = String(value);
  const plain = /^[\x20-\x7E]*$/.test(text) && text.trim() === text && !(text.startsWith('=?base64?') && text.endsWith('?='));
  if (plain) return text;
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

async function rpc(server, method, params = {}, options = {}) {
  const mode = server.protocolMode || 'auto';
  if (!['auto', MCP_PROTOCOL_VERSION].includes(mode)) {
    const error = new Error(`Unsupported configured MCP protocol mode: ${mode}`);
    error.code = 'UNSUPPORTED_MCP_VERSION';
    throw error;
  }
  const endpoint = validateEndpointUrl(server.url, {
    insecureConfirmedOrigin: server.insecureTransportAcknowledgedOrigin
  });
  if (!endpoint.ok) throw coded(endpoint.error.code, endpoint.error.message, endpoint.error.details);
  const requestId = nextId++;
  let transportParams = params;
  let parameterHeaders = [];
  if (method === 'tools/call' && options.toolDefinition?.inputSchema) {
    const extracted = extractMcpParameterHeaders(options.toolDefinition.inputSchema, params.arguments || {});
    parameterHeaders = extracted.headers;
    transportParams = { ...params, arguments: extracted.arguments };
  }
  const fullParams = { ...transportParams, _meta: requestMeta() };
  const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: fullParams });
  const operation = createOperationSignal(options.signal, options.timeoutMs || LIMITS.MCP_CALL_TIMEOUT_MS, adapters);
  try {
    const response = await raceWithSignal(adapters.fetchImpl(endpoint.url, {
      method: 'POST',
      redirect: 'error',
      headers: buildHeaders(server, method, fullParams, parameterHeaders),
      body,
      signal: operation.signal
    }), operation.signal);
    const data = await readResponseAsJsonRpc(response, requestId, operation.signal);
    if (!response.ok) throw httpError(response.status, data);
    if (data?.error) throw jsonRpcError(data.error);
    if (data?.id !== requestId) {
      const error = new Error(`MCP response id mismatch (expected ${requestId}).`);
      error.code = 'MCP_RESPONSE_ID_MISMATCH';
      throw error;
    }
    return data.result;
  } catch (error) {
    if (operation.code === 'TIMEOUT') {
      const timeout = new Error('MCP request timed out.');
      timeout.code = 'TIMEOUT';
      throw timeout;
    }
    if (operation.code === 'CANCELLED' || isAbortError(error)) {
      const cancelled = new Error('MCP request cancelled.');
      cancelled.code = 'CANCELLED';
      throw cancelled;
    }
    throw error;
  } finally {
    operation.cleanup();
  }
}

export async function readResponseAsJsonRpc(response, requestId, signal) {
  const contentType = (response.headers?.get?.('Content-Type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) return readSseResponse(response.body, requestId, signal);
  const text = await readResponseTextBounded(response, {
    maxBytes: LIMITS.MAX_MCP_RESPONSE_BYTES,
    signal,
    errorCode: 'MCP_RESPONSE_TOO_LARGE',
    errorMessage: 'MCP response exceeds the 2 MiB limit.'
  });
  try { return JSON.parse(text); }
  catch { throw coded('MCP_INVALID_JSON', `Unexpected MCP response (${response.status}): ${text.slice(0, 200)}`); }
}

export async function readSseResponse(stream, requestId, signal) {
  if (!stream?.getReader) throw coded('MCP_INVALID_STREAM', 'MCP SSE response has no readable body.');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let bytes = 0;
  let malformed = 0;

  function consumeEvent() {
    if (!dataLines.length) return null;
    const raw = dataLines.join('\n');
    dataLines = [];
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      malformed += 1;
      if (malformed > 8) throw coded('MCP_MALFORMED_SSE', 'Too many malformed MCP SSE events.');
      return null;
    }
    if (parsed?.id === requestId) return parsed;
    return null;
  }

  function consumeLine(line) {
    if (line === '') return consumeEvent();
    if (line.startsWith(':')) return null;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    return null;
  }

  try {
    while (true) {
      if (signal?.aborted) throw coded('CANCELLED', 'MCP request cancelled.');
      const { value, done } = await raceWithSignal(reader.read(), signal);
      if (value) {
        bytes += value.byteLength;
        if (bytes > LIMITS.MAX_MCP_RESPONSE_BYTES) throw coded('MCP_RESPONSE_TOO_LARGE', 'MCP response exceeds the 2 MiB limit.');
        buffer += decoder.decode(value, { stream: !done });
      } else if (done) buffer += decoder.decode();

      while (true) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        if (match[0] === '\r' && match.index === buffer.length - 1 && !done) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const found = consumeLine(line);
        if (found) return found;
      }
      if (done) break;
    }
    if (buffer) {
      const found = consumeLine(buffer);
      if (found) return found;
    }
    const final = consumeEvent();
    if (final) return final;
    throw coded('MCP_STREAM_ENDED', 'MCP stream ended before the matching response.');
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

export async function listMcpToolsDetailed(server, signal, options = {}) {
  const key = cacheKey(server);
  const cached = discoveryCache.get(key);
  const now = adapters.now();
  if (!options.forceRefresh && cached && cached.expiresAt > now) {
    return { ...cached.value, cache: { status: 'hit', expiresAt: cached.expiresAt } };
  }

  const tools = [];
  const errors = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  let ttlMs = DEFAULT_CACHE_MS;
  let cacheScope = 'private';
  do {
    pages += 1;
    if (pages > LIMITS.MAX_MCP_PAGES) throw coded('MCP_PAGE_LIMIT', `MCP tools/list exceeded ${LIMITS.MAX_MCP_PAGES} pages.`);
    const params = cursor ? { cursor } : {};
    const result = await rpc(server, 'tools/list', params, { signal, timeoutMs: LIMITS.MCP_DISCOVERY_TIMEOUT_MS });
    if (result?.resultType && result.resultType !== 'complete') throw coded('MCP_INPUT_REQUIRED_UNSUPPORTED', 'MCP tools/list requested unsupported multi-round input.');
    for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
      if (!tool || typeof tool.name !== 'string' || seen.has(tool.name)) {
        errors.push({ code: 'DUPLICATE_OR_INVALID_TOOL', name: tool?.name || '', message: 'Tool name is missing or duplicated.' });
        continue;
      }
      const schema = validateToolSchema(tool.inputSchema || { type: 'object', properties: {} }, { allowMcpHeaders: true });
      if (!schema.ok) {
        errors.push({ code: 'INVALID_MCP_SCHEMA', name: tool.name, message: schema.error.message });
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
      if (tools.length > LIMITS.MAX_MCP_TOOLS) throw coded('MCP_TOOL_LIMIT', `MCP discovery exceeded ${LIMITS.MAX_MCP_TOOLS} tools.`);
    }
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (Number.isFinite(result?.ttlMs)) ttlMs = Math.min(ttlMs, Math.max(0, result.ttlMs));
    if (typeof result?.cacheScope === 'string') cacheScope = result.cacheScope;
  } while (cursor);

  ttlMs = Math.min(Math.max(ttlMs, 0), MAX_CACHE_MS);
  const value = { tools, errors, version: MCP_PROTOCOL_VERSION, pages, ttlMs, cacheScope };
  const expiresAt = now + ttlMs;
  discoveryCache.set(key, { serverId: server.id, expiresAt, value });
  return { ...value, cache: { status: 'miss', expiresAt } };
}

export async function listMcpTools(server, signal, options = {}) {
  return (await listMcpToolsDetailed(server, signal, options)).tools;
}

export async function callMcpTool(server, name, args, signal, toolDefinition = null) {
  const result = await rpc(server, 'tools/call', { name, arguments: args || {} }, { signal, toolDefinition });
  if (result?.resultType === 'input_required') throw coded('MCP_INPUT_REQUIRED_UNSUPPORTED', 'This MCP tool requires multi-round user input, which this client does not expose yet.');
  return result;
}

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
  } else if (typeof result === 'object') parts.push(JSON.stringify(result));
  return parts.join('\n');
}

function cacheKey(server) {
  const headerDigest = stableHash(Object.entries(server.headers || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k.toLowerCase()}:${v}`).join('|'));
  return `${server.id}|${server.url}|${server.protocolMode || 'auto'}|${headerDigest}`;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  }
  return value;
}

function httpError(status, data) {
  if (data?.error) return jsonRpcError(data.error, status);
  return coded('MCP_HTTP_ERROR', `MCP HTTP ${status}.`, { status });
}

function jsonRpcError(error, status = null) {
  const unsupported = error?.code === -32022;
  return coded(
    unsupported ? 'UNSUPPORTED_MCP_VERSION' : 'MCP_JSON_RPC_ERROR',
    unsupported
      ? `Server does not support MCP ${MCP_PROTOCOL_VERSION}. Supported versions: ${(error?.data?.supported || []).join(', ') || 'not provided'}.`
      : `MCP error: ${error?.message || JSON.stringify(error)}`,
    { status, rpcCode: error?.code, data: error?.data }
  );
}

function coded(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details != null) error.details = details;
  return error;
}
