# Plan 012: Consolidate the runtime protocol and feature controllers

> **Executor instructions**: Execute after plans 003 and 006. This is an
> incremental behavior-preserving refactor. Extend the run envelope from plan
> 003; do not introduce a competing protocol. Update plan 012 in
> <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/shared src/content/isolated.js src/content/main.js src/background/service-worker.js src/background/agent.js src/sidepanel/app.js src/sidepanel/state.js src/sidepanel/settings-panel.js src/sidepanel/chat.js README.md TESTING.md test</code>
> A mismatch with plan 003's run envelope or plan 006's cancellation contract
> is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**:
  <code>plans/003-isolate-agent-runs.md</code>,
  <code>plans/006-propagate-cancellation.md</code>
- **Category**: tech-debt
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The extension has four hand-maintained string protocols across the isolated
content bridge, main-world script, service worker, and side panel. Payload
shape drift often becomes a timeout or ignored event. Large mutable modules
then coordinate messaging, storage, streaming, attachments, and UI state
directly, making small changes difficult to test.

After this plan, message types and envelopes have one shared definition and
boundary validation, request/response correlation is consistent, and the
largest controllers are split along existing feature seams without adding a
framework or build requirement.

## Current state

- <code>src/content/isolated.js:5-55</code> owns an
  <code>ASYNC_TYPES</code> request/response map and a 12-second listener.
- <code>src/content/main.js:619-633</code> independently switches on
  <code>TYPST_AGENT_*</code> page messages.
- <code>src/background/service-worker.js:120-203</code> independently routes
  storage, page, stream, title, and quick-attach messages.
- <code>src/sidepanel/app.js:640-658</code> independently routes agent events.
- Plan 003 should have created <code>src/shared/protocol.js</code> with minimal
  run types and validation. Preserve its run identity.
- <code>settings-panel.js</code> is roughly 900 lines and owns unrelated
  registries, settings tabs, sessions, and import/export.
- <code>app.js</code> is roughly 740 lines and owns tab state, sessions,
  attachments, streaming, naming, settings startup, and UI wiring.
- <code>agent.js</code> is roughly 730 lines and owns provider transport,
  preflight, page/custom/MCP execution, discovery, loop state, and titles.
- Existing design intentionally uses native ESM plus main-world IIFEs with no
  runtime build.

## Target protocol

All extension-internal messages use:

~~~js
{
  type,
  requestId,
  runId,
  payload
}
~~~

Rules:

- <code>requestId</code> is required for request/response pairs.
- <code>runId</code> is required only for run-scoped messages but must never be
  inferred.
- Payload validators reject unknown/missing required fields at every context
  boundary.
- Responses use one explicit success/error shape.
- Timeouts name the request type and ID.
- Page-world messages include an unpredictable per-tab bridge nonce in
  addition to request ID so unrelated same-window messages cannot satisfy a
  pending request accidentally.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/protocol.test.mjs test/run-routing.test.mjs test/browser-smoke.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | all bridge/startup tests pass |
| Literal audit | <code>rg -n "'(AI_|GET_|SESSION_|TYPST_AGENT_)[A-Z_]+'" src --glob "*.js"</code> | only protocol definitions/tests or documented bridge adapters |
| Cycle check | <code>npm run check:imports</code> | exit 0, no cycles |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/shared/protocol.js</code>
- <code>src/content/isolated.js</code>
- <code>src/content/main.js</code>
- <code>src/background/service-worker.js</code>
- <code>src/background/agent.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/state.js</code>
- <code>src/sidepanel/settings-panel.js</code>
- <code>src/sidepanel/chat.js</code> only for extracted stream controller calls
- New focused modules under <code>src/background/</code> and
  <code>src/sidepanel/</code>
- <code>scripts/check-imports.mjs</code> (create)
- <code>test/protocol.test.mjs</code> (create)
- <code>test/run-routing.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>ARCHITECTURE.md</code> (create)
- <code>README.md</code> and <code>TESTING.md</code>

**Out of scope**:

- React, TypeScript, a bundler, or source-wide formatting.
- Changing provider/MCP wire protocols.
- Rewriting CSS solely to mirror JavaScript modules.
- New product features.
- Changing public session export format.

## Git workflow

- Branch: <code>codex/012-consolidate-runtime-protocol</code>
- Use small behavior-preserving commits:
  - <code>test: lock runtime message protocol</code>
  - <code>refactor: centralize message envelopes</code>
  - <code>refactor: extract feature controllers</code>
  - <code>docs: describe extension architecture</code>
- Do not push or publish.

## Steps

### Step 1: Inventory every message as a protocol matrix

Before editing, add a table to <code>ARCHITECTURE.md</code> or a test fixture
listing:

- message type;
- sender context;
- receiver context;
- request/response/event;
- required request/run IDs;
- payload schema;
- timeout/terminal behavior.

Cover side-panel↔service-worker, service-worker↔isolated-world,
isolated↔main-world, quick-attach, tab changes, storage, titles, preflight, and
all stream events.

Add tests that enumerate the same registry and fail for duplicate type values
or missing validators.

**Verify**: protocol registry count equals the documented matrix count.

### Step 2: Expand the shared protocol module

Extend plan 003's module with:

- grouped type constants;
- pure envelope builders;
- discriminated JSDoc typedefs;
- payload validators/normalizers;
- stable structured success/error response helpers;
- request ID generation;
- type-to-response mapping where needed.

Do not make the shared module import browser, DOM, storage, or feature
controllers. It must remain pure and usable in Node tests and all ESM
extension contexts.

Main-world IIFEs cannot import ESM directly. Generate or expose only the
minimal page-bridge constant/validator adapter required there, and keep its
values asserted against the shared registry by static tests. Do not duplicate
the whole protocol.

**Verify**: <code>node --test test/protocol.test.mjs</code> passes.

### Step 3: Migrate one boundary at a time

Order:

1. side panel to service worker;
2. service worker to isolated world;
3. isolated world to main world;
4. main world responses back;
5. service-worker agent events to side panel;
6. quick-attach and tab-change events.

For each boundary:

- accept only new envelopes;
- validate before dispatch;
- return structured errors;
- correlate request ID;
- retain run ID where required;
- update focused tests before moving on.

Do not maintain indefinite dual legacy/new paths. A single commit may include
a temporary adapter, but remove it before completing the plan.

**Verify**: run protocol and browser tests after each boundary.

### Step 4: Add a per-tab bridge nonce and deterministic cleanup

Generate a random nonce in the isolated world, transfer it to the injected
main-world bridge through the controlled bootstrap, and require it on every
same-window message. Pair it with request ID and expected response type.

Pending listeners must:

- be stored in one map rather than one event listener per request;
- clean up on response, timeout, cancellation, tab unload, and extension
  reload;
- reject duplicate response IDs;
- bound concurrent pending requests.

This protects correctness/correlation; do not claim it prevents a fully
compromised host page from controlling its own editor.

**Verify**: simultaneous response, wrong nonce, duplicate ID, timeout, and
cleanup tests pass.

### Step 5: Extract controllers behind explicit interfaces

Perform behavior-preserving extraction in small steps:

- from <code>agent.js</code>: provider stream transport and tool registry/
  dispatch orchestration, retaining one run coordinator;
- from <code>app.js</code>: session controller, attachment controller, and run
  UI controller;
- from <code>settings-panel.js</code>: model registry, custom/MCP registry,
  and session-management controller.

Each controller receives dependencies explicitly and owns its state
transitions. Avoid a generic utils module. Keep DOM construction with the
feature that owns it.

Do not move code only to reduce line count; extract when an interface and
focused test can be named.

**Verify**: focused tests for each extracted controller pass before deleting
the old inline copy.

### Step 6: Add import-cycle and protocol-literal checks

Create <code>scripts/check-imports.mjs</code> using Node built-ins to:

- parse static relative imports;
- report cycles;
- ensure shared protocol does not import feature/browser modules;
- flag raw protocol literals outside the approved definition/adapter files.

Add <code>check:imports</code> to <code>npm run verify</code>.

**Verify**: <code>npm run check:imports</code> exits 0.

### Step 7: Complete architecture documentation

Document:

- execution worlds and trust boundaries;
- startup/injection lifecycle;
- message matrix;
- run lifecycle;
- storage ownership;
- controller ownership;
- how to add a message/tool safely;
- which paths require browser QA.

Link <code>ARCHITECTURE.md</code> from README and TESTING. Keep it compact
enough to maintain; do not create duplicate ADR/CONTEXT/DESIGN files.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Protocol registry uniqueness and required-validator tests.
- Builder/validator success and failure cases.
- Request ID and run ID correlation.
- Wrong nonce, wrong response type, duplicate response, timeout, cancellation,
  unload cleanup, pending-request limit.
- One complete request across every context boundary in browser smoke.
- Controller tests matching plan 001's injected-dependency conventions.
- Import-cycle and raw-literal static checks.

## Done criteria

- [ ] One shared protocol registry defines every extension-internal message.
- [ ] Every boundary validates an envelope and structured response.
- [ ] Request/run IDs are never inferred from active global state.
- [ ] The page bridge uses nonce + request ID and one bounded pending map.
- [ ] No temporary legacy protocol adapter remains.
- [ ] Named feature controllers own sessions, attachments, run UI, provider
  stream, and registries.
- [ ] Import-cycle and raw-message-literal checks run under verify.
- [ ] ARCHITECTURE.md documents contexts, lifecycle, protocol, and ownership.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 012 is marked DONE.

## STOP conditions

Stop and report if:

- Plan 003's run protocol cannot be extended without breaking its invariants.
- A context cannot consume the shared registry because of MV3 execution-world
  restrictions and no small tested adapter is possible.
- Extraction reveals a circular ownership decision that changes behavior
  rather than moving code.
- The refactor requires a bundler/framework or a source-wide rewrite.
- A message has no discoverable sender/receiver or intentional semantics.

## Maintenance notes

- New message types require registry, validator, matrix entry, and tests.
- Keep shared code pure and dependency-light.
- Reviewers should reject string literals that bypass the protocol registry.
- Split styles only alongside future feature UI changes, not for symmetry.
