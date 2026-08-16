/** Bounded JSON Schema and argument validation shared by UI and worker code. */
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_NODES = 500;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_ERRORS = 8;

const ANNOTATION_KEYS = new Set([
  '$schema', 'title', 'description', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly'
]);
const VALIDATION_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'enum', 'const', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', 'allOf', 'anyOf', 'oneOf', 'x-mcp-header'
]);
const KNOWN_KEYS = new Set([...ANNOTATION_KEYS, ...VALIDATION_KEYS]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export function validateToolSchema(schema, options = {}) {
  const state = { nodes: 0, errors: [], allowMcpHeaders: !!options.allowMcpHeaders, headerNames: new Set() };
  validateSchemaNode(schema, '$', 0, state, true, true);
  if (state.errors.length) return { ok: false, error: state.errors[0], errors: state.errors };
  return { ok: true, value: schema };
}

export function parseToolArguments(raw) {
  if (typeof raw !== 'string') return fail('ARGUMENTS_NOT_JSON_TEXT', '$', 'Tool arguments must be a JSON string.');
  if (new TextEncoder().encode(raw).length > MAX_ARGUMENT_BYTES) return fail('ARGUMENTS_TOO_LARGE', '$', 'Tool arguments exceed the 256 KiB limit.');
  let value;
  try { value = JSON.parse(raw); }
  catch { return fail('ARGUMENTS_PARSE_ERROR', '$', 'Tool arguments are not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('ARGUMENTS_ROOT_TYPE', '$', 'Tool arguments must be a JSON object.');
  }
  return { ok: true, value };
}

export function validateToolArguments(value, schema) {
  const schemaCheck = validateToolSchema(schema, { allowMcpHeaders: true });
  if (!schemaCheck.ok) return schemaCheck;
  const state = { errors: [], seen: 0 };
  validateValue(value, schema, '$', 0, state);
  if (state.errors.length) return { ok: false, error: state.errors[0], errors: state.errors };
  return { ok: true, value };
}

export function parseAndValidateToolArguments(raw, schema) {
  const parsed = parseToolArguments(raw);
  if (!parsed.ok) return parsed;
  return validateToolArguments(parsed.value, schema);
}

function validateSchemaNode(schema, path, depth, state, isRoot, staticallyReachable) {
  if (state.errors.length >= MAX_ERRORS) return;
  if (depth > MAX_SCHEMA_DEPTH) return add(state, 'SCHEMA_DEPTH_LIMIT', path, 'Schema nesting exceeds the supported depth.');
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) return add(state, 'SCHEMA_NODE_LIMIT', path, 'Schema is too large.');
  if (typeof schema === 'boolean') {
    if (isRoot) add(state, 'SCHEMA_ROOT_TYPE', `${path}.type`, 'Tool schemas must have type "object" at the root.');
    return;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return add(state, 'SCHEMA_TYPE', path, 'Schema nodes must be objects or booleans.');

  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYS.has(key)) add(state, 'UNSUPPORTED_SCHEMA_KEYWORD', `${path}.${key}`, `Unsupported JSON Schema keyword: ${key}`);
  }
  if (isRoot && schema.type !== 'object') add(state, 'SCHEMA_ROOT_TYPE', `${path}.type`, 'Tool schemas must have type "object" at the root.');
  if (schema.type != null && (!TYPES.has(schema.type) || typeof schema.type !== 'string')) add(state, 'SCHEMA_INVALID_TYPE', `${path}.type`, 'Schema type is not supported.');
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some(x => typeof x !== 'string'))) add(state, 'SCHEMA_REQUIRED', `${path}.required`, 'required must be an array of property names.');
  if (schema.properties != null && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) add(state, 'SCHEMA_PROPERTIES', `${path}.properties`, 'properties must be an object.');
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean') add(state, 'SCHEMA_ADDITIONAL_PROPERTIES', `${path}.additionalProperties`, 'additionalProperties must be boolean in the supported subset.');
  if (schema.pattern != null) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 256) add(state, 'SCHEMA_PATTERN', `${path}.pattern`, 'pattern must be a string of at most 256 characters.');
    else {
      let syntaxValid = true;
      try { new RegExp(schema.pattern, 'u'); }
      catch {
        syntaxValid = false;
        add(state, 'SCHEMA_PATTERN', `${path}.pattern`, 'pattern is not a valid regular expression.');
      }
      if (syntaxValid && !isLinearPatternSubset(schema.pattern)) {
        add(state, 'SCHEMA_PATTERN_UNSAFE', `${path}.pattern`, 'pattern uses regex features that are not supported by the linear-time safety subset.');
      }
    }
  }
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (schema[key] != null && (!Number.isInteger(schema[key]) || schema[key] < 0)) add(state, 'SCHEMA_BOUND', `${path}.${key}`, `${key} must be a non-negative integer.`);
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] != null && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) add(state, 'SCHEMA_BOUND', `${path}.${key}`, `${key} must be a finite number.`);
  }
  if (schema.enum != null && (!Array.isArray(schema.enum) || schema.enum.length > 1_000)) add(state, 'SCHEMA_ENUM', `${path}.enum`, 'enum must be a bounded array.');

  if (schema['x-mcp-header'] != null) {
    const header = schema['x-mcp-header'];
    if (!state.allowMcpHeaders) add(state, 'UNSUPPORTED_SCHEMA_KEYWORD', `${path}.x-mcp-header`, 'x-mcp-header is only supported for MCP-discovered schemas.');
    else if (!staticallyReachable || !['string', 'integer', 'boolean'].includes(schema.type) || typeof header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) {
      add(state, 'INVALID_MCP_HEADER', `${path}.x-mcp-header`, 'x-mcp-header must be a unique HTTP token on a statically reachable string, integer, or boolean property.');
    } else {
      const lower = header.toLowerCase();
      if (state.headerNames.has(lower)) add(state, 'DUPLICATE_MCP_HEADER', `${path}.x-mcp-header`, 'x-mcp-header names must be case-insensitively unique.');
      state.headerNames.add(lower);
    }
  }

  for (const [key, child] of Object.entries(schema.properties || {})) validateSchemaNode(child, `${path}.properties.${key}`, depth + 1, state, false, staticallyReachable);
  if (schema.items != null) validateSchemaNode(schema.items, `${path}.items`, depth + 1, state, false, false);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[key] == null) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0 || schema[key].length > 20) add(state, 'SCHEMA_COMPOSITION', `${path}.${key}`, `${key} must be a non-empty bounded array.`);
    else schema[key].forEach((child, i) => validateSchemaNode(child, `${path}.${key}[${i}]`, depth + 1, state, false, false));
  }
}

/**
 * Deliberately conservative subset for patterns supplied by custom/MCP tools.
 * With no groups, alternation, backreferences, or multiple variable-length
 * quantifiers, JavaScript's backtracking engine cannot grow exponentially.
 */
function isLinearPatternSubset(pattern) {
  let escaped = false;
  let inClass = false;
  let variableQuantifiers = 0;
  let hasQuantifier = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      if (/[1-9]/.test(char) || char === 'k') return false;
      escaped = false;
      continue;
    }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(' || char === ')' || char === '|') return false;
    if (char === '*' || char === '+' || char === '?') {
      hasQuantifier = true;
      variableQuantifiers += 1;
      if (variableQuantifiers > 1) return false;
      continue;
    }
    if (char !== '{') continue;
    const close = pattern.indexOf('}', index + 1);
    if (close < 0) continue;
    const body = pattern.slice(index + 1, close);
    const quantifier = body.match(/^(\d+)(?:,(\d*))?$/);
    if (!quantifier) continue;
    hasQuantifier = true;
    const minimum = Number(quantifier[1]);
    const hasRange = quantifier[2] != null;
    const maximum = hasRange && quantifier[2] !== '' ? Number(quantifier[2]) : minimum;
    if (minimum > 10_000 || maximum > 10_000) return false;
    if (hasRange && (quantifier[2] === '' || maximum !== minimum)) {
      variableQuantifiers += 1;
      if (variableQuantifiers > 1) return false;
    }
    index = close;
  }
  const anchored = pattern.startsWith('^') && pattern.endsWith('$') && !isEscapedAt(pattern, pattern.length - 1);
  return !escaped && !inClass && (!hasQuantifier || anchored);
}

function isEscapedAt(value, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function validateValue(value, schema, path, depth, state) {
  if (state.errors.length >= MAX_ERRORS) return;
  state.seen += 1;
  if (state.seen > 100_000 || depth > MAX_SCHEMA_DEPTH) return add(state, 'ARGUMENT_COMPLEXITY', path, 'Arguments are too deeply nested or large.');
  if (schema === true) return;
  if (schema === false) return add(state, 'SCHEMA_FALSE', path, 'Value is rejected by the schema.');

  if (schema.const !== undefined && !deepEqual(value, schema.const)) add(state, 'CONST', path, 'Value does not match const.');
  if (Array.isArray(schema.enum) && !schema.enum.some(item => deepEqual(item, value))) add(state, 'ENUM', path, 'Value is not one of the allowed enum values.');
  if (schema.type && !matchesType(value, schema.type)) add(state, 'TYPE', path, `Expected ${schema.type}.`);
  if (state.errors.length >= MAX_ERRORS || (schema.type && !matchesType(value, schema.type))) return;

  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) add(state, 'MIN_LENGTH', path, `String must contain at least ${schema.minLength} characters.`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) add(state, 'MAX_LENGTH', path, `String must contain at most ${schema.maxLength} characters.`);
    if (schema.pattern != null && !new RegExp(schema.pattern, 'u').test(value)) add(state, 'PATTERN', path, 'String does not match the required pattern.');
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) add(state, 'MINIMUM', path, `Number must be at least ${schema.minimum}.`);
    if (schema.maximum != null && value > schema.maximum) add(state, 'MAXIMUM', path, `Number must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) add(state, 'ARRAY_LIMIT', path, 'Array exceeds the supported length.');
    if (schema.minItems != null && value.length < schema.minItems) add(state, 'MIN_ITEMS', path, `Array must contain at least ${schema.minItems} items.`);
    if (schema.maxItems != null && value.length > schema.maxItems) add(state, 'MAX_ITEMS', path, `Array must contain at most ${schema.maxItems} items.`);
    if (schema.items !== undefined && value.length <= MAX_ARRAY_LENGTH) value.forEach((item, i) => validateValue(item, schema.items, `${path}[${i}]`, depth + 1, state));
  }
  if (isPlainObject(value)) {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) add(state, 'REQUIRED', `${path}.${key}`, `Missing required property: ${key}`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.prototype.hasOwnProperty.call(value, key)) validateValue(value[key], child, `${path}.${key}`, depth + 1, state);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) add(state, 'ADDITIONAL_PROPERTY', `${path}.${key}`, `Unexpected property: ${key}`);
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(schema[key])) continue;
    const matches = schema[key].filter(child => trialValidate(value, child, path, depth)).length;
    if (key === 'allOf' && matches !== schema[key].length) add(state, 'ALLOF', path, 'Value does not satisfy allOf.');
    if (key === 'anyOf' && matches === 0) add(state, 'ANYOF', path, 'Value does not satisfy anyOf.');
    if (key === 'oneOf' && matches !== 1) add(state, 'ONEOF', path, 'Value must satisfy exactly one oneOf branch.');
  }
}

function trialValidate(value, schema, path, depth) {
  const trial = { errors: [], seen: 0 };
  validateValue(value, schema, path, depth + 1, trial);
  return trial.errors.length === 0;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a == null || b == null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

function add(state, code, path, message) {
  if (state.errors.length < MAX_ERRORS) state.errors.push({ code, path, message });
}

function fail(code, path, message) {
  return { ok: false, error: { code, path, message } };
}
