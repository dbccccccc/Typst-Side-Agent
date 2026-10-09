/** Custom HTTP tools and MCP tools: bounded network dispatch with run cancellation. */
import { LIMITS } from '../../shared/constants.js';
import { createOperationSignal, isAbortError, raceWithSignal, throwIfAborted } from '../../shared/abort.js';
import { readResponseTextBounded } from '../../shared/bounded-response.js';
import { validateEndpointUrl } from '../../shared/endpoint-policy.js';
import { codedError } from '../../shared/errors.js';
import { renderMcpContent } from '../mcp.js';
import { adapters } from './agent-adapters.js';
import { cancelled } from './page-bridge.js';

export function boundToolText(text) {
  const value = String(text || '');
  if (value.length <= LIMITS.MAX_TOOL_RESULT_MODEL_CHARS) return value;
  return `${value.slice(0, LIMITS.MAX_TOOL_RESULT_MODEL_CHARS)}\n... (tool result truncated)`;
}

export async function executeCustomTool(run, tool, args) {
  const operation = createOperationSignal(run.signal, LIMITS.CUSTOM_TOOL_TIMEOUT_MS, adapters);
  try {
    throwIfAborted(operation.signal);
    const endpoint = validateEndpointUrl(tool.endpoint, { insecureConfirmedOrigin: tool.insecureTransportAcknowledgedOrigin });
    if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
    const response = await raceWithSignal(adapters.fetchImpl(endpoint.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(tool.headers || {}) },
      body: JSON.stringify({ tool: tool.name, arguments: args }),
      signal: operation.signal
    }), operation.signal);
    const text = await readResponseTextBounded(response, {
      maxBytes: LIMITS.MAX_CUSTOM_TOOL_RESPONSE_BYTES,
      signal: operation.signal,
      errorCode: 'CUSTOM_RESPONSE_TOO_LARGE',
      errorMessage: 'Custom-tool response exceeds the 256 KiB limit.'
    });
    throwIfAborted(operation.signal);
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 64_000) }; }
    if (!response.ok) return { ok: false, code: 'CUSTOM_HTTP_ERROR', error: `HTTP ${response.status}`, body: parsed };
    return { ok: true, result: parsed };
  } catch (error) {
    if (operation.code === 'TIMEOUT') return { ok: false, code: 'TIMEOUT', error: 'Custom tool timed out.' };
    if (operation.code === 'CANCELLED' || isAbortError(error)) throw cancelled();
    return { ok: false, code: error.code || 'CUSTOM_TOOL_ERROR', error: error.message || String(error) };
  } finally {
    operation.cleanup();
  }
}

export async function executeMcpTool(run, source, args) {
  try {
    const result = await adapters.callMcpTool(source.server, source.tool.name, args, run.signal, source.tool);
    if (result?.isError) return { ok: false, code: 'MCP_TOOL_ERROR', error: boundToolText(renderMcpContent(result)) || 'MCP tool error' };
    return { ok: true, content: boundToolText(renderMcpContent(result)) };
  } catch (error) {
    if (error.code === 'CANCELLED') throw error;
    return { ok: false, code: error.code || 'MCP_TOOL_ERROR', error: error.message || String(error) };
  }
}

export async function discoverMcpToolset(run) {
  throwIfAborted(run.signal);
  const servers = await raceWithSignal(adapters.loadMcpServers(), run.signal);
  throwIfAborted(run.signal);
  const enabled = servers.filter(server => server.enabled !== false);
  return Promise.all(enabled.map(async server => {
    try {
      const detail = await adapters.listMcpToolsDetailed(server, run.signal);
      return { server, ...detail };
    } catch (error) {
      if (error.code === 'CANCELLED') throw error;
      return {
        server,
        tools: [],
        errors: [],
        error: { code: error.code || 'MCP_DISCOVERY_ERROR', message: error.message || String(error) }
      };
    }
  }));
}
