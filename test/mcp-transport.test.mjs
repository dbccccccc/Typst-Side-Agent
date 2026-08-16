import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_PROTOCOL_VERSION, callMcpTool, configureMcpAdapters, encodeHeaderValue,
  listMcpToolsDetailed, readResponseAsJsonRpc, readSseResponse, resetMcpAdapters
} from '../src/background/mcp.js';
import { jsonResponse, streamFromStrings } from './helpers/fakes.mjs';
import { LIMITS } from '../src/shared/constants.js';

afterEach(() => resetMcpAdapters());

const server = { id: 'server-1', name: 'fixture', url: 'https://mcp.example/rpc', protocolMode: 'auto', headers: { Authorization: 'Bearer fixture' } };

test('current stateless MCP discovery sends required metadata/headers, paginates, validates, and caches', async () => {
  const requests = [];
  configureMcpAdapters({
    now: () => 1000,
    clientVersion: () => '9.8.7',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ body, headers: options.headers, redirect: options.redirect });
      const second = body.params.cursor === 'next';
      return jsonResponse({
        jsonrpc: '2.0', id: body.id,
        result: second
          ? { tools: [{ name: 'second', inputSchema: { type: 'object', properties: {} } }], ttlMs: 5000, cacheScope: 'private' }
          : {
              tools: [
                { name: 'first', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
                { name: 'bad', inputSchema: { type: 'object', patternProperties: {} } }
              ],
              nextCursor: 'next', ttlMs: 8000
            }
      });
    }
  });
  const first = await listMcpToolsDetailed(server);
  assert.equal(first.version, MCP_PROTOCOL_VERSION);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.tools.map(tool => tool.name), ['first', 'second']);
  assert.equal(first.errors[0].code, 'INVALID_MCP_SCHEMA');
  assert.equal(first.cache.status, 'miss');
  assert.equal(requests[0].headers['MCP-Protocol-Version'], MCP_PROTOCOL_VERSION);
  assert.equal(requests[0].headers['Mcp-Method'], 'tools/list');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[0].body.params._meta['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
  assert.equal(requests[0].body.params._meta['io.modelcontextprotocol/clientInfo'].version, '9.8.7');
  const cached = await listMcpToolsDetailed(server);
  assert.equal(cached.cache.status, 'hit');
  assert.equal(requests.length, 2);
});

test('tools/call maps validated x-mcp-header arguments and protects protocol headers', async () => {
  let captured;
  configureMcpAdapters({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    captured = { body, headers: options.headers };
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  } });
  const definition = { inputSchema: { type: 'object', properties: {
    locale: { type: 'string', 'x-mcp-header': 'X-Locale' },
    query: { type: 'string' }
  } } };
  await callMcpTool(server, 'translate', { locale: 'en-US', query: 'hello' }, null, definition);
  assert.equal(captured.headers['Mcp-Name'], 'translate');
  assert.equal(captured.headers['Mcp-Param-X-Locale'], 'en-US');
  assert.equal(Object.hasOwn(captured.body.params.arguments, 'locale'), false);
  assert.equal(captured.body.params.arguments.query, 'hello');

  await assert.rejects(callMcpTool({ ...server, headers: { 'Mcp-Method': 'override' } }, 'x', {}, null), error => error.code === 'MCP_HEADER_CONFLICT');
});

test('SSE parser handles CRLF, comments, arbitrary chunks, and multiline data', async () => {
  const stream = streamFromStrings([
    ': keepalive\r',
    '\ndata: {"jsonrpc":"2.0",\r\n',
    'data: "id":7,"result":{"tools":[]}}\r\n\r',
    '\n'
  ]);
  const result = await readSseResponse(stream, 7);
  assert.deepEqual(result.result, { tools: [] });
});

test('MCP rejects mismatched IDs and unsupported configured versions', async () => {
  configureMcpAdapters({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse({ jsonrpc: '2.0', id: body.id + 1, result: { tools: [] } });
  } });
  await assert.rejects(listMcpToolsDetailed(server, null, { forceRefresh: true }), error => error.code === 'MCP_RESPONSE_ID_MISMATCH');
  await assert.rejects(listMcpToolsDetailed({ ...server, protocolMode: '2025-03-26' }, null, { forceRefresh: true }), error => error.code === 'UNSUPPORTED_MCP_VERSION');
});

test('timeout and cancellation terminate pending MCP operations', async () => {
  configureMcpAdapters({
    fetchImpl: () => new Promise(() => {}),
    setTimeoutImpl: callback => { queueMicrotask(callback); return 1; },
    clearTimeoutImpl: () => {}
  });
  await assert.rejects(listMcpToolsDetailed(server, null, { forceRefresh: true }), error => error.code === 'TIMEOUT');

  const controller = new AbortController();
  const pending = readSseResponse(streamFromStrings([], { holdOpen: true }), 1, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
});

test('non-ASCII MCP header values use the declared base64 wrapper', () => {
  const encoded = encodeHeaderValue(' café ');
  assert.match(encoded, /^=\?base64\?.+\?=$/);
});

test('MCP rejects hostile response boundaries before retaining oversized bodies', async () => {
  const declaredTooLarge = new Response('{}', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(LIMITS.MAX_MCP_RESPONSE_BYTES + 1) }
  });
  await assert.rejects(readResponseAsJsonRpc(declaredTooLarge, 1), error => error.code === 'MCP_RESPONSE_TOO_LARGE');

  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(LIMITS.MAX_MCP_RESPONSE_BYTES + 1));
      controller.close();
    }
  });
  await assert.rejects(readSseResponse(oversizedStream, 1), error => error.code === 'MCP_RESPONSE_TOO_LARGE');
  await assert.rejects(
    readSseResponse(streamFromStrings(Array.from({ length: 9 }, () => 'data: not-json\n\n')), 1),
    error => error.code === 'MCP_MALFORMED_SSE'
  );
  await assert.rejects(readSseResponse(streamFromStrings(['data: {"jsonrpc":"2.0","id":2}\n\n']), 1), error => error.code === 'MCP_STREAM_ENDED');
});

test('MCP discovery enforces page and tool-count limits', async () => {
  configureMcpAdapters({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: `page-${body.id}` } });
  } });
  await assert.rejects(
    listMcpToolsDetailed({ ...server, id: 'page-limit' }, null, { forceRefresh: true }),
    error => error.code === 'MCP_PAGE_LIMIT'
  );

  configureMcpAdapters({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    const tools = Array.from({ length: LIMITS.MAX_MCP_TOOLS + 1 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: { type: 'object', properties: {} }
    }));
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools } });
  } });
  await assert.rejects(
    listMcpToolsDetailed({ ...server, id: 'tool-limit' }, null, { forceRefresh: true }),
    error => error.code === 'MCP_TOOL_LIMIT'
  );
});

test('MCP dispatch rejects legacy cleartext consent at the final network boundary', async () => {
  let fetches = 0;
  configureMcpAdapters({ fetchImpl: async () => { fetches += 1; return jsonResponse({}); } });
  await assert.rejects(
    listMcpToolsDetailed({ ...server, id: 'legacy-http', url: 'http://192.168.1.5/rpc', insecureTransportAcknowledged: true }, null, { forceRefresh: true }),
    error => error.code === 'INSECURE_CONFIRMATION_REQUIRED'
  );
  assert.equal(fetches, 0);
});
