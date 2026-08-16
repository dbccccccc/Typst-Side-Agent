import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_TOOLS } from '../src/background/tools.js';
import { parseAndValidateToolArguments } from '../src/shared/tool-validation.js';

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

test('read_diagnostics exposes no model-controlled delay parameter', () => {
  const schema = BUILTIN_TOOLS.find(tool => tool.function.name === 'read_diagnostics').function.parameters;
  assert.deepEqual(schema.properties, {});
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(parseAndValidateToolArguments('{}', schema).value, {});
  assert.equal(parseAndValidateToolArguments('{"delay_ms":1}', schema).error.code, 'ADDITIONAL_PROPERTY');
});
