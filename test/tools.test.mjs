import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_TOOLS, PAGE_TOOL_NAMES, customToolToSpec, mcpToolToSpec } from '../src/background/tools.js';

// ---------- built-in registry sanity ----------

test('BUILTIN_TOOLS: every entry is a valid OpenAI-style function spec', () => {
  for (const tool of BUILTIN_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.function?.name, 'has name');
    assert.ok(tool.function?.description, 'has description');
    assert.equal(tool.function?.parameters?.type, 'object');
  }
});

test('BUILTIN_TOOLS: names are unique', () => {
  const names = BUILTIN_TOOLS.map(t => t.function.name);
  assert.equal(new Set(names).size, names.length);
});

test('PAGE_TOOL_NAMES: all referenced names actually exist in BUILTIN_TOOLS', () => {
  const names = new Set(BUILTIN_TOOLS.map(t => t.function.name));
  for (const n of PAGE_TOOL_NAMES) {
    assert.ok(names.has(n), `${n} missing from BUILTIN_TOOLS`);
  }
});

// ---------- customToolToSpec ----------

test('customToolToSpec: passes through custom schema', () => {
  const spec = customToolToSpec({
    name: 'search_arxiv',
    description: 'Search arXiv.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  });
  assert.equal(spec.function.name, 'search_arxiv');
  assert.equal(spec.function.description, 'Search arXiv.');
  assert.equal(spec.function.parameters.properties.query.type, 'string');
});

test('customToolToSpec: fills in default description and parameters', () => {
  const spec = customToolToSpec({ name: 'bare' });
  assert.ok(spec.function.description.includes('bare'));
  assert.deepEqual(spec.function.parameters, { type: 'object', properties: {} });
});

// ---------- mcpToolToSpec ----------

test('mcpToolToSpec: namespaces tool name as mcp__<server>__<tool>', () => {
  const spec = mcpToolToSpec('srv-1', 'filesystem', {
    name: 'read_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
  });
  assert.equal(spec.function.name, 'mcp__filesystem__read_file');
  assert.ok(spec.function.description.startsWith('[MCP filesystem]'));
  assert.equal(spec.function.parameters.properties.path.type, 'string');
});

test('mcpToolToSpec: sanitises unsafe chars in server / tool names', () => {
  const spec = mcpToolToSpec('id', 'hello world', { name: 'foo/bar baz' });
  assert.equal(spec.function.name, 'mcp__hello_world__foo_bar_baz');
});

test('mcpToolToSpec: caps server (24) and tool (48) segment length', () => {
  const spec = mcpToolToSpec('id', 'x'.repeat(40), { name: 'y'.repeat(80) });
  const [, server, tool] = spec.function.name.split('__');
  assert.ok(server.length <= 24);
  assert.ok(tool.length <= 48);
});

test('mcpToolToSpec: default empty parameters when inputSchema missing', () => {
  const spec = mcpToolToSpec('id', 'fs', { name: 'ping' });
  assert.deepEqual(spec.function.parameters, { type: 'object', properties: {} });
});
