import { BUILTIN_TOOLS, BUILTIN_TOOL_METADATA } from './tools.js';
import { validateEndpointUrl } from '../shared/endpoint-policy.js';
import { validateToolSchema } from '../shared/tool-validation.js';
import {
  customToolTrustFingerprint, hasCurrentCustomToolTrust, hasCurrentMcpServerTrust,
  mcpServerTrustFingerprint, mcpVisibleName, stableHash
} from '../shared/trust-policy.js';

export {
  customToolTrustFingerprint, hasCurrentCustomToolTrust, hasCurrentMcpServerTrust,
  mcpServerTrustFingerprint, mcpVisibleName, stableHash
};

export function buildToolRegistry({ customTools = [], mcpEntries = [] } = {}) {
  const routes = new Map();
  const specs = [];
  const errors = [];

  for (const spec of BUILTIN_TOOLS) {
    const name = spec.function.name;
    addRoute(routes, specs, errors, name, {
      name,
      identity: `builtin:${name}`,
      kind: 'builtin',
      schema: spec.function.parameters,
      spec,
      ...BUILTIN_TOOL_METADATA[name]
    });
  }

  const customNameCheck = validateCustomToolRecords(customTools);
  if (!customNameCheck.ok) errors.push(...customNameCheck.errors);
  for (const tool of customTools.filter(t => t?.enabled !== false)) {
    const schema = tool.parameters ?? { type: 'object', properties: {} };
    const schemaCheck = validateToolSchema(schema);
    if (!schemaCheck.ok) {
      errors.push(registryError('INVALID_CUSTOM_SCHEMA', tool.name, schemaCheck.error.message));
      continue;
    }
    const endpoint = validateEndpointUrl(tool.endpoint, { insecureConfirmedOrigin: tool.insecureTransportAcknowledgedOrigin });
    if (!endpoint.ok) {
      errors.push(registryError(endpoint.error.code, tool.name, endpoint.error.message));
      continue;
    }
    const spec = { type: 'function', function: { name: tool.name, description: tool.description || `Custom tool: ${tool.name}`, parameters: schema } };
    addRoute(routes, specs, errors, tool.name, {
      name: tool.name,
      identity: `custom:${tool.id}`,
      kind: 'custom',
      schema,
      spec,
      effect: 'external',
      approval: hasCurrentCustomToolTrust(tool) ? 'trusted' : 'once',
      destination: endpoint.origin,
      source: tool
    });
  }

  for (const entry of mcpEntries) {
    for (const tool of entry.tools || []) {
      const schema = tool.inputSchema ?? { type: 'object', properties: {} };
      const schemaCheck = validateToolSchema(schema, { allowMcpHeaders: true });
      if (!schemaCheck.ok) {
        errors.push(registryError('INVALID_MCP_SCHEMA', `${entry.server?.name}/${tool.name}`, schemaCheck.error.message));
        continue;
      }
      const name = mcpVisibleName(entry.server, tool);
      const spec = {
        type: 'function',
        function: {
          name,
          description: tool.description ? `[MCP ${entry.server.name}] ${tool.description}` : `[MCP ${entry.server.name}] ${tool.name}`,
          parameters: schema
        }
      };
      addRoute(routes, specs, errors, name, {
        name,
        identity: `mcp:${entry.server.id}:${tool.name}`,
        kind: 'mcp',
        schema,
        spec,
        effect: 'external',
        approval: hasCurrentMcpServerTrust(entry.server) ? 'trusted' : 'once',
        destination: safeOrigin(entry.server.url),
        source: { server: entry.server, tool }
      });
    }
  }

  return { routes, specs, errors };
}

export function validateCustomToolRecords(tools) {
  const errors = [];
  const seen = new Map();
  const seenIds = new Set();
  const reserved = new Set(BUILTIN_TOOLS.map(t => t.function.name.toLowerCase()));
  for (const tool of Array.isArray(tools) ? tools : []) {
    const id = String(tool?.id || '');
    const name = String(tool?.name || '');
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) errors.push(registryError('INVALID_TOOL_ID', name, 'Custom tool id is missing or invalid.'));
    else if (seenIds.has(id)) errors.push(registryError('DUPLICATE_TOOL_ID', name, 'Custom tool ids must be unique.'));
    else seenIds.add(id);
    if (!/^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(name)) errors.push(registryError('INVALID_TOOL_NAME', name, 'Function name must be 2-41 letters, digits, or underscores and start with a letter.'));
    if (reserved.has(lower)) errors.push(registryError('RESERVED_TOOL_NAME', name, `Custom tool conflicts with built-in tool "${name}".`));
    if (seen.has(lower)) errors.push(registryError('DUPLICATE_TOOL_NAME', name, `Custom tool conflicts with "${seen.get(lower)}".`));
    else seen.set(lower, name);
    const schema = validateToolSchema(tool?.parameters ?? { type: 'object', properties: {} });
    if (!schema.ok) errors.push(registryError('INVALID_CUSTOM_SCHEMA', name, schema.error.message));
  }
  return errors.length ? { ok: false, errors, error: errors[0] } : { ok: true, value: tools };
}

function addRoute(routes, specs, errors, name, route) {
  if (routes.has(name)) {
    errors.push(registryError('TOOL_NAME_COLLISION', name, `Visible function name collides with ${routes.get(name).identity}.`));
    return;
  }
  routes.set(name, route);
  specs.push(route.spec);
}

function registryError(code, name, message) {
  return { code, name, message };
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return '(invalid destination)'; }
}
