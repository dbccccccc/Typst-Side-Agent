# Plan 004: Validate tool registries and arguments fail-closed

> **Executor instructions**: Execute after plan 001. Treat provider output,
> imported custom schemas, and MCP schemas as untrusted data. Invalid tool
> calls must become structured errors and must never reach an editor or
> network endpoint. Update plan 004 in <code>plans/README.md</code> when done.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/agent.js src/background/tools.js src/content/main.js src/sidepanel/settings-panel.js src/sidepanel/index.html README.md TESTING.md test package.json package-lock.json</code>
> A changed tool-spec or dispatch contract is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: <code>plans/001-establish-verification-baseline.md</code>
- **Category**: bug, security
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

Malformed provider arguments currently become an empty object. For
<code>replace_selection</code>, the page bridge then converts missing text to
an empty string, which deletes the current selection. Custom and MCP calls are
also dispatched without enforcing the schemas shown to the model, and lossy
tool-name normalization can silently route a call to the wrong integration.

After this plan, parsing, schema validation, registry construction, and
dispatch all fail closed with structured, model-visible errors.

## Current state

- <code>src/background/agent.js:475-480</code>:

  ~~~js
  let parsedArgs = {};
  try { parsedArgs = JSON.parse(tc.arguments); } catch { /* ignore */ }
  ~~~

- <code>src/content/main.js:191-198</code> converts a missing
  <code>replace_selection.text</code> to <code>''</code>.
- <code>src/sidepanel/settings-panel.js:372-375</code> verifies only that a
  custom schema is parseable JSON.
- <code>src/background/tools.js:169-175</code> forwards that schema to the
  model without an enforcement layer.
- <code>README.md:151-154</code> promises arguments validated by JSON Schema.
- <code>src/sidepanel/settings-panel.js:357-383</code> checks custom-name
  syntax but not uniqueness or reserved built-in names.
- <code>src/background/tools.js:181-189</code> sanitizes and truncates MCP
  server/tool name segments.
- <code>src/background/agent.js:531-540</code> stores MCP routes in a
  <code>Map</code>; a collision overwrites the earlier route.
- Existing tool tests use <code>node:test</code> in
  <code>test/tools.test.mjs</code>. Match that style.

## Supported schema contract

Implement and document one explicit JSON-Schema subset sufficient for current
built-ins and common custom/MCP tools:

- boolean schemas;
- <code>type</code> for object, array, string, number, integer, boolean, and
  null;
- <code>properties</code>, <code>required</code>, and
  <code>additionalProperties</code>;
- <code>items</code>, <code>minItems</code>, and <code>maxItems</code>;
- <code>enum</code> and <code>const</code>;
- string <code>minLength</code>, <code>maxLength</code>, and
  <code>pattern</code>;
- numeric <code>minimum</code> and <code>maximum</code>;
- local composition with <code>allOf</code>, <code>anyOf</code>, and
  <code>oneOf</code> only if required by an existing built-in or test fixture.

Do not claim support for remote references, code-generating formats, or an
entire draft unless they are actually implemented. Unsupported schema keywords
must be rejected when saving a custom tool and surfaced as an integration
error for MCP discovery.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/tool-validation.test.mjs test/tools.test.mjs test/agent-integration.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Find fail-open parse | <code>rg -n "parsedArgs = \\{\\}|catch \\{ /\\* ignore \\*/ \\}" src/background/agent.js</code> | no tool-argument match |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/background/tool-validation.js</code> (create)
- <code>src/background/tool-registry.js</code> (create if registry extraction
  is the smallest clean seam)
- <code>src/background/agent.js</code>
- <code>src/background/tools.js</code>
- <code>src/content/main.js</code>
- <code>src/sidepanel/settings-panel.js</code>
- <code>src/sidepanel/index.html</code> for validation errors only
- <code>test/tool-validation.test.mjs</code> (create)
- <code>test/tools.test.mjs</code>
- <code>test/agent-integration.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>README.md</code>
- <code>TESTING.md</code>

**Out of scope**:

- Approval prompts and trust policy; plan 007 owns them.
- MCP wire-protocol changes; plan 008 owns them.
- Redesigning editor operations or adding new tools.
- Sending malformed arguments after a warning.
- Dynamically evaluating schema code or fetching remote schema references.

## Git workflow

- Branch: <code>codex/004-validate-tool-dispatch</code>
- Suggested commits:
  - <code>test: cover invalid tool calls</code>
  - <code>fix: validate tool dispatch fail closed</code>
- Do not push or publish.

## Steps

### Step 1: Add regression tests for destructive and ambiguous cases

Create failing tests for:

- malformed JSON for every page mutation tool;
- missing and wrong-type required fields;
- <code>replace_selection</code> with missing text while a selection exists;
- custom arguments violating required/type/additional-property constraints;
- unsupported custom schema keywords;
- a custom name equal to a built-in;
- duplicate custom names;
- two MCP names that normalize to the same visible function name;
- a schema whose root is not an object where the tool contract requires one.

The destructive regression must assert that the fake editor receives no
dispatch at all.

**Verify**: the focused test file reports the current failures before the fix.

### Step 2: Implement a pure schema and argument validator

Create a pure module returning structured results:

~~~js
{ ok: true, value }
{ ok: false, error: { code, path, message } }
~~~

Requirements:

- Parse raw argument JSON separately from schema validation.
- Reject parse errors; never substitute an empty object.
- Validate the schema itself when a custom tool is saved.
- Validate parsed arguments immediately before dispatch, even if the provider
  was given the same schema.
- Bound recursion depth, input size, array length, and error count so a hostile
  schema cannot stall the service worker.
- Produce deterministic, concise errors safe to send back to the model and
  display in the tool block.

Implement the documented subset as a small pure module. Do not add a schema
dependency in this plan; dynamic evaluation, remote references, and a new
runtime bundling path are outside scope.

**Verify**: <code>node --test test/tool-validation.test.mjs</code> passes.

### Step 3: Validate built-in, custom, and MCP calls at one dispatch boundary

Build one lookup from exposed function name to:

- source kind,
- original tool identity,
- parameter schema,
- executor.

Before execution:

1. Require a nonempty call ID and function name.
2. Parse arguments fail-closed.
3. Validate against the exact advertised schema.
4. Return a structured tool error on failure.
5. Call the executor only on success.

Remove <code>tc.parsedArgs || {}</code> fallbacks that hide invalid state.
Keep diagnostics ordering and bottom-to-top line edit ordering unchanged.

At the page boundary, pass values through without coercing missing required
fields to empty strings. Each editor function should return its existing
specific error for invalid values.

**Verify**: focused agent/content tests prove no editor or fetch adapter is
called for invalid input.

### Step 4: Make registry names deterministic and collision-free

At settings save:

- reject custom names that equal any built-in;
- reject duplicates case-insensitively if providers treat names that way;
- show the conflicting integration in the error.

For MCP:

- derive a deterministic visible name using a readable slug plus a stable
  fragment of immutable server ID;
- enforce the provider's supported function-name length in one helper;
- detect any residual collision before sending tools to the model;
- fail discovery for the conflicting entries rather than overwriting a map.

Do not silently rename an existing custom function, because user prompts and
external endpoints may depend on it. Present a migration error requiring the
user to choose a new custom name.

**Verify**: collision tests pass and the registry contains one unique route per
exposed name.

### Step 5: Align settings, README, and QA with the real contract

Document:

- the supported schema subset/dialect;
- save-time and dispatch-time validation;
- structured error behavior;
- reserved/unique naming rules;
- the deterministic MCP namespace format if it changes.

Update the settings help text so unsupported schemas are rejected before
saving.

**Verify**: static documentation tests or direct assertions confirm the README
no longer promises more than the implementation.

## Test plan

- Create <code>test/tool-validation.test.mjs</code> for the pure validator and
  registry.
- Extend <code>test/tools.test.mjs</code> for names.
- Extend agent integration tests to assert executor call counts remain zero on
  invalid arguments.
- Include nested object/array paths, extra properties, integer versus number,
  enum/const, pattern, recursion/size limits, unsupported keywords, and
  ambiguous names.
- Browser smoke: attempt an invalid page mutation and confirm the document
  fixture is unchanged.

## Done criteria

- [ ] Malformed JSON never becomes an empty argument object.
- [ ] Missing <code>replace_selection.text</code> cannot delete a selection.
- [ ] Every built-in/custom/MCP call is validated before dispatch.
- [ ] Unsupported custom schemas cannot be saved.
- [ ] Duplicate/reserved custom names are rejected.
- [ ] MCP normalization cannot overwrite another route.
- [ ] README and settings describe the implemented schema subset.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 004 is marked DONE.

## STOP conditions

Stop and report if:

- Existing built-in schemas require a keyword outside the chosen subset and
  implementing it would materially expand scope.
- A candidate validator requires dynamic code evaluation, remote code, or
  Node-only APIs unavailable in an MV3 service worker.
- Provider function-name constraints cannot be determined from the supported
  provider contract.
- Correct migration would silently change existing custom endpoint function
  names.

## Maintenance notes

- New tools must add a schema and validation tests in the same change.
- Plan 007 will consume source/effect metadata from the unified registry.
- Plan 008 must validate discovered MCP schemas before exposing tools.
- Reviewers should focus on fail-closed behavior and ensure no fallback
  recreates <code>{}</code> after a parse error.
