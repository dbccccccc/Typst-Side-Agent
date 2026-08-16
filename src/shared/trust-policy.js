const MAX_FUNCTION_NAME = 64;

export function mcpVisibleName(server, tool) {
  const serverSlug = slug(server?.name || 'server', 14);
  const toolSlug = slug(tool?.name || 'tool', 28);
  const serverHash = stableHash(String(server?.id || server?.url || serverSlug)).slice(0, 6);
  const toolHash = stableHash(String(tool?.name || toolSlug)).slice(0, 6);
  return `mcp__${serverSlug}_${serverHash}__${toolSlug}_${toolHash}`.slice(0, MAX_FUNCTION_NAME);
}

export function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

export function customToolTrustFingerprint(tool) {
  return configurationFingerprint('custom-v1', {
    id: tool?.id || '',
    name: tool?.name || '',
    description: tool?.description || '',
    endpoint: tool?.endpoint || '',
    headers: tool?.headers || {},
    parameters: tool?.parameters || { type: 'object', properties: {} }
  });
}

export function mcpServerTrustFingerprint(server) {
  return configurationFingerprint('mcp-v1', {
    id: server?.id || '',
    name: server?.name || '',
    url: server?.url || '',
    headers: server?.headers || {},
    protocolMode: server?.protocolMode || 'auto'
  });
}

export function hasCurrentCustomToolTrust(tool) {
  return !!tool?.trustedAutoRun && tool.trustedAutoRunFingerprint === customToolTrustFingerprint(tool);
}

export function hasCurrentMcpServerTrust(server) {
  return !!server?.trustedAutoRun && server.trustedAutoRunFingerprint === mcpServerTrustFingerprint(server);
}

function configurationFingerprint(prefix, value) {
  const canonical = canonicalJson(value);
  return `${prefix}:${canonical.length}:${stableHash(canonical)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function slug(value, max) {
  const out = String(value).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  return out.slice(0, max);
}
