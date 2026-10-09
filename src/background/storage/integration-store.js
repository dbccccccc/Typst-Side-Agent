/** Custom HTTP tool and MCP server registries with trust-fingerprint normalization. */
import { STORAGE_KEYS } from '../../shared/constants.js';
import {
  normalizeInsecureAcknowledgement, validateEndpointUrl, validateHeaderRecord
} from '../../shared/endpoint-policy.js';
import { codedError } from '../../shared/errors.js';
import {
  customToolTrustFingerprint, hasCurrentCustomToolTrust, hasCurrentMcpServerTrust,
  mcpServerTrustFingerprint
} from '../../shared/trust-policy.js';
import { validateCustomToolRecords } from '../tool-registry.js';
import { enqueueMutation, isRecordId, readKey, writeKey } from './storage-core.js';

const SUPPORTED_MCP_MODES = ['auto', '2026-07-28'];

export async function loadCustomTools() {
  const tools = await readKey(STORAGE_KEYS.CUSTOM_TOOLS, []);
  return Array.isArray(tools) ? tools.map(normalizeCustomTool) : [];
}

function applyRecordMutation(records, mutation) {
  if (!mutation) return records;
  if (mutation.type === 'replace') return mutation.records.map(record => ({ ...record }));
  if (mutation.type === 'upsert') {
    const next = records.map(record => ({ ...record }));
    const position = next.findIndex(record => record.id === mutation.record.id);
    if (position >= 0) next[position] = { ...next[position], ...mutation.record };
    else next.push({ ...mutation.record });
    return next;
  }
  if (mutation.type === 'remove') return records.filter(record => record.id !== mutation.id);
  if (mutation.type === 'toggle') {
    return records.map(record => record.id === mutation.id ? { ...record, enabled: record.enabled === false } : record);
  }
  throw codedError('INVALID_REGISTRY_MUTATION', 'Unsupported registry mutation.');
}

export async function saveCustomTools(tools, mutation = null) {
  return enqueueMutation(async () => {
    const candidate = mutation ? applyRecordMutation(await loadCustomTools(), mutation) : tools;
    const check = validateCustomToolRecords(candidate);
    if (!check.ok) throw codedError(check.error.code, check.error.message);
    const safe = candidate.map(normalizeCustomTool);
    for (const tool of safe) {
      const endpoint = validateEndpointUrl(tool.endpoint, { insecureConfirmedOrigin: tool.insecureTransportAcknowledgedOrigin });
      if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
      const headers = validateHeaderRecord(tool.headers);
      if (!headers.ok) throw codedError(headers.error.code, headers.error.message);
    }
    await writeKey(STORAGE_KEYS.CUSTOM_TOOLS, safe);
    return { ok: true, records: safe };
  });
}

export async function loadMcpServers() {
  const servers = await readKey(STORAGE_KEYS.MCP_SERVERS, []);
  return Array.isArray(servers) ? servers.map(normalizeMcpServer) : [];
}

export async function saveMcpServers(servers, mutation = null) {
  return enqueueMutation(async () => {
    const candidate = mutation ? applyRecordMutation(await loadMcpServers(), mutation) : servers;
    if (!Array.isArray(candidate)) throw codedError('INVALID_MCP_SETTINGS', 'MCP servers must be an array.');
    const safe = candidate.map(normalizeMcpServer);
    const ids = new Set();
    for (const server of safe) {
      if (!isRecordId(server?.id)) throw codedError('INVALID_MCP_SERVER_ID', 'Every MCP server requires a valid id.');
      if (ids.has(server.id)) throw codedError('DUPLICATE_MCP_SERVER_ID', 'MCP server ids must be unique.');
      ids.add(server.id);
      const endpoint = validateEndpointUrl(server.url, { insecureConfirmedOrigin: server.insecureTransportAcknowledgedOrigin });
      if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
      const headers = validateHeaderRecord(server.headers, { mcp: true });
      if (!headers.ok) throw codedError(headers.error.code, headers.error.message);
      if (!SUPPORTED_MCP_MODES.includes(server.protocolMode || 'auto')) {
        throw codedError('UNSUPPORTED_MCP_VERSION', 'Supported MCP modes are Auto and 2026-07-28.');
      }
    }
    await writeKey(STORAGE_KEYS.MCP_SERVERS, safe);
    return { ok: true, records: safe };
  });
}

function normalizeCustomTool(tool) {
  const endpointSafe = normalizeInsecureAcknowledgement(tool, 'endpoint');
  const trusted = hasCurrentCustomToolTrust(endpointSafe);
  return {
    ...endpointSafe,
    trustedAutoRun: trusted,
    trustedAutoRunFingerprint: trusted ? customToolTrustFingerprint(endpointSafe) : null
  };
}

function normalizeMcpServer(server) {
  const endpointSafe = normalizeInsecureAcknowledgement({ ...server, protocolMode: server?.protocolMode || 'auto' }, 'url');
  const trusted = hasCurrentMcpServerTrust(endpointSafe);
  return {
    ...endpointSafe,
    trustedAutoRun: trusted,
    trustedAutoRunFingerprint: trusted ? mcpServerTrustFingerprint(endpointSafe) : null
  };
}
