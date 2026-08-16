import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidateToolArguments, parseToolArguments, validateToolSchema } from '../src/shared/tool-validation.js';
import {
  buildToolRegistry, validateCustomToolRecords
} from '../src/background/tool-registry.js';
import {
  customToolTrustFingerprint, mcpServerTrustFingerprint, mcpVisibleName
} from '../src/shared/trust-policy.js';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 2, maxLength: 20 },
    count: { type: 'integer', minimum: 1, maximum: 5 }
  },
  required: ['query'],
  additionalProperties: false
};

test('tool arguments parse and validate without silent fallback', () => {
  assert.equal(parseToolArguments('{').error.code, 'ARGUMENTS_PARSE_ERROR');
  assert.equal(parseToolArguments('[]').error.code, 'ARGUMENTS_ROOT_TYPE');
  assert.deepEqual(parseAndValidateToolArguments('{"query":"ok","count":2}', schema).value, { query: 'ok', count: 2 });
  assert.equal(parseAndValidateToolArguments('{"query":"x"}', schema).error.path, '$.query');
  assert.equal(parseAndValidateToolArguments('{"query":"ok","extra":1}', schema).error.code, 'ADDITIONAL_PROPERTY');
});

test('unsupported and dangerous schema ambiguity is rejected at registration', () => {
  assert.equal(validateToolSchema({ type: 'object', properties: {}, patternProperties: {} }).error.code, 'UNSUPPORTED_SCHEMA_KEYWORD');
  assert.equal(validateToolSchema({ type: 'array', items: { type: 'string' } }).error.code, 'SCHEMA_ROOT_TYPE');
  assert.equal(validateToolSchema({ type: 'object', properties: { x: { type: 'string', pattern: '[' } } }).error.code, 'SCHEMA_PATTERN');
  assert.equal(validateToolSchema(true).error.code, 'SCHEMA_ROOT_TYPE');
  assert.equal(validateToolSchema(false).error.code, 'SCHEMA_ROOT_TYPE');
  assert.equal(validateToolSchema({ type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } }).error.code, 'SCHEMA_PATTERN_UNSAFE');
  assert.equal(validateToolSchema({ type: 'object', properties: { x: { type: 'string', pattern: '^a+a+$' } } }).error.code, 'SCHEMA_PATTERN_UNSAFE');
  assert.equal(validateToolSchema({ type: 'object', properties: { x: { type: 'string', pattern: '[a]+b' } } }).error.code, 'SCHEMA_PATTERN_UNSAFE');
  assert.equal(validateToolSchema({ type: 'object', properties: { x: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } }).ok, true);
});

test('boolean items and structural enum/const values follow JSON Schema semantics', () => {
  const noItems = {
    type: 'object',
    properties: { values: { type: 'array', items: false } },
    required: ['values']
  };
  assert.equal(parseAndValidateToolArguments('{"values":[]}', noItems).ok, true);
  assert.equal(parseAndValidateToolArguments('{"values":[1]}', noItems).error.code, 'SCHEMA_FALSE');

  const structural = {
    type: 'object',
    properties: {
      exact: { const: { a: 1, b: 2 } },
      choice: { enum: [{ nested: { x: true, y: false } }] }
    },
    required: ['exact', 'choice']
  };
  assert.equal(parseAndValidateToolArguments('{"exact":{"b":2,"a":1},"choice":{"nested":{"y":false,"x":true}}}', structural).ok, true);
});

test('root false schemas never default to permissive custom-tool arguments', () => {
  const registry = buildToolRegistry({ customTools: [{
    id: 'false-root', name: 'reject_all', endpoint: 'https://tool.example/call', parameters: false
  }] });
  assert.equal(registry.routes.has('reject_all'), false);
  assert.equal(registry.errors.some(error => error.code === 'INVALID_CUSTOM_SCHEMA'), true);
});

test('MCP parameter headers require unique reachable scalar properties', () => {
  const valid = validateToolSchema({
    type: 'object', properties: { locale: { type: 'string', 'x-mcp-header': 'X-Locale' } }
  }, { allowMcpHeaders: true });
  assert.equal(valid.ok, true);
  const duplicate = validateToolSchema({
    type: 'object', properties: {
      a: { type: 'string', 'x-mcp-header': 'X-Choice' },
      b: { type: 'integer', 'x-mcp-header': 'x-choice' }
    }
  }, { allowMcpHeaders: true });
  assert.equal(duplicate.error.code, 'DUPLICATE_MCP_HEADER');
});

test('custom registry rejects built-in, duplicate, and invalid names', () => {
  const records = [
    { id: 'a', name: 'read_document', parameters: { type: 'object', properties: {} } },
    { id: 'a', name: 'Lookup', parameters: { type: 'object', properties: {} } },
    { id: 'c', name: 'lookup', parameters: { type: 'object', properties: {} } }
  ];
  const checked = validateCustomToolRecords(records);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some(error => error.code === 'RESERVED_TOOL_NAME'));
  assert.ok(checked.errors.some(error => error.code === 'DUPLICATE_TOOL_NAME'));
  assert.ok(checked.errors.some(error => error.code === 'DUPLICATE_TOOL_ID'));
});

test('registry assigns restrictive effect metadata and collision-resistant MCP names', () => {
  const custom = {
    id: 'custom-1', name: 'lookup', endpoint: 'https://tools.example/call', enabled: true,
    parameters: { type: 'object', properties: {} }
  };
  const mcpEntries = [{ server: { id: 'server-a', name: 'same', url: 'https://mcp.example/a' }, tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }] }];
  const registry = buildToolRegistry({ customTools: [custom], mcpEntries });
  assert.equal(registry.errors.length, 0);
  assert.deepEqual({ effect: registry.routes.get('lookup').effect, approval: registry.routes.get('lookup').approval }, { effect: 'external', approval: 'once' });
  const mcpName = mcpVisibleName(mcpEntries[0].server, mcpEntries[0].tools[0]);
  assert.equal(registry.routes.get(mcpName).destination, 'https://mcp.example');
  assert.notEqual(mcpVisibleName({ id: 'server-b', name: 'same' }, { name: 'read' }), mcpName);
});

test('saved trust is bound to the exact custom and MCP configurations', () => {
  const custom = {
    id: 'custom-1', name: 'lookup', endpoint: 'https://tools.example/call', enabled: true,
    headers: { Authorization: 'Bearer fixture' }, parameters: { type: 'object', properties: {} },
    trustedAutoRun: true
  };
  custom.trustedAutoRunFingerprint = customToolTrustFingerprint(custom);
  const server = {
    id: 'server-1', name: 'fixture', url: 'https://mcp.example/rpc', protocolMode: 'auto',
    headers: {}, trustedAutoRun: true
  };
  server.trustedAutoRunFingerprint = mcpServerTrustFingerprint(server);
  const tool = { name: 'read', inputSchema: { type: 'object', properties: {} } };
  const trusted = buildToolRegistry({ customTools: [custom], mcpEntries: [{ server, tools: [tool] }] });
  assert.equal(trusted.routes.get('lookup').approval, 'trusted');
  assert.equal(trusted.routes.get(mcpVisibleName(server, tool)).approval, 'trusted');

  const editedCustom = { ...custom, endpoint: 'https://other.example/call' };
  const editedServer = { ...server, headers: { Authorization: 'changed' } };
  const edited = buildToolRegistry({ customTools: [editedCustom], mcpEntries: [{ server: editedServer, tools: [tool] }] });
  assert.equal(edited.routes.get('lookup').approval, 'once');
  assert.equal(edited.routes.get(mcpVisibleName(editedServer, tool)).approval, 'once');
});
