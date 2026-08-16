# Plan 006: Propagate cancellation through every run operation

> **Executor instructions**: Execute after plan 003. Cancellation is
> run-specific; do not reintroduce a global controller. A stopped run must not
> continue discovery, network traffic, page mutation, or event emission.
> Update plan 006 in <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/agent.js src/background/mcp.js src/background/service-worker.js src/sidepanel/app.js src/shared test</code>
> Compare against plan 003's live run registry rather than the pre-plan global
> excerpt. Missing per-run identity is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: <code>plans/003-isolate-agent-runs.md</code>
- **Category**: bug
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The Stop action currently aborts only the central model controller and
preflight waiters. Custom tools create unrelated timeout controllers, MCP
calls omit the available signal, and the main controller is created only after
MCP discovery. A user can press Stop while network work and side effects
continue.

After this plan, one run signal reaches discovery, provider streaming,
preflight, page calls, custom tools, MCP tools, and any waits. Timeout remains
an additional bound, not a replacement for user cancellation.

## Current state

At the planned commit, before plan 003:

- <code>src/background/agent.js:270-290</code> creates an independent custom
  tool controller used only for its 30-second timeout.
- <code>src/background/agent.js:293-297</code> calls MCP without a signal even
  though <code>src/background/mcp.js:91-92</code> accepts one.
- <code>src/background/agent.js:524-526</code> completes tool/MCP discovery
  before creating the main controller at lines 566-568.
- <code>src/background/agent.js:505-509</code> aborts only the global
  controller and preflight waiters.
- <code>src/sidepanel/app.js:451-455</code> shows Stopping and sends
  <code>AI_STREAM_CANCEL</code>.
- Plan 003 replaces the global controller with a per-run registry and
  run-specific cancel message. Build on that state.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/cancellation.test.mjs test/agent-integration.test.mjs test/mcp-transport.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | exit 0 |
| Signal search | <code>rg -n "executeCustomTool|executeMcpTool|discoverMcpToolset" src/background/agent.js</code> | every call/definition accepts run signal |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/shared/abort.js</code> (create)
- <code>src/background/agent.js</code>
- <code>src/background/mcp.js</code>
- <code>src/background/service-worker.js</code>
- <code>src/sidepanel/app.js</code>
- <code>test/cancellation.test.mjs</code> (create)
- <code>test/agent-integration.test.mjs</code>
- <code>test/mcp-transport.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>TESTING.md</code>

**Out of scope**:

- MCP version/protocol changes.
- Tool approval policy.
- Global cancel-all UI.
- Retrying a cancelled operation automatically.
- Changing timeout durations except to centralize existing constants.

## Git workflow

- Branch: <code>codex/006-propagate-cancellation</code>
- Suggested commit: <code>fix: propagate run cancellation</code>
- Do not push or publish.

## Steps

### Step 1: Add deterministic cancellation tests

Cover cancellation:

- before MCP discovery returns;
- while provider headers are pending;
- during provider body streaming;
- while a preflight waiter is open;
- before custom-tool headers;
- while reading a custom-tool response;
- before and during MCP SSE;
- immediately before a page mutation;
- after a run is already complete.

Each fake operation must record whether its signal aborted and whether it
performed its side effect. Tests must use deferred promises rather than real
30-second timers.

**Verify**: the focused cases fail against the missing signal paths before the
fix.

### Step 2: Create the run controller before discovery

At accepted run start:

1. Create and register the run controller.
2. Attach it to the immutable run record from plan 003.
3. Pass its signal to custom-tool loading/discovery and every later operation.
4. Clean the run entry in <code>finally</code>.

If cancellation occurs before model streaming, emit exactly one terminal
cancelled event for that run and return a structured cancelled result.

**Verify**: cancel-during-discovery test passes.

### Step 3: Combine run cancellation with per-operation timeouts

Create a small helper that returns:

- a signal aborted when either the parent run signal or timeout fires;
- a cleanup function that clears timers and listeners;
- a way to distinguish timeout from user cancellation for error text.

Do not assume <code>AbortSignal.any</code> unless the declared Chrome and Node
minimums support it and tests cover both environments. A manual helper is
acceptable and should be pure apart from timer/controller creation.

Use it for custom tools, MCP calls, and any other operation that currently
owns a separate controller.

**Verify**: timeout and parent-cancel tests produce distinct structured codes
and no listener/timer leak.

### Step 4: Thread the signal through every executor

Require a signal parameter in:

- MCP discovery;
- each <code>listMcpTools</code>;
- custom tool execution;
- MCP tool execution;
- page preflight sleeps and message waits;
- page tool forwarding where cancellation can prevent dispatch;
- provider streaming.

Check the signal immediately before any editor mutation/network dispatch.
After abort, suppress later tool results and stream chunks for that run while
still performing deterministic cleanup.

**Verify**: executor-call counters remain zero when cancellation wins before
dispatch.

### Step 5: Make side-panel cancellation terminal and testable

The side panel must:

- send the active run ID;
- disable repeated Stop requests for that run;
- transition from Stopping to a terminal cancelled state on acknowledgement;
- preserve any already-rendered partial response in the originating session;
- ignore chunks arriving after terminal cancellation.

Document expected partial-history behavior in <code>TESTING.md</code>.

**Verify**: browser smoke stops a delayed mock custom/MCP request and receives
no later UI update.

## Test plan

- Use fake timers/deferred operations; no long sleeps.
- Assert exactly one terminal event.
- Assert cleanup of run registry, timers, preflight waiters, and abort
  listeners.
- Assert cancelling run A does not touch run B.
- Assert user cancellation and timeout have different stable error codes.
- Assert no custom/MCP/page side effect occurs after cancellation.

## Done criteria

- [ ] The run controller exists before discovery begins.
- [ ] Every network/tool/preflight/page path consumes the run signal.
- [ ] Timeouts compose with, rather than replace, user cancellation.
- [ ] No post-cancel chunks or tool results reach the UI.
- [ ] Partial output persists only to the originating session.
- [ ] Cancel is idempotent for completed/unknown runs.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 006 is marked DONE.

## STOP conditions

Stop and report if:

- Plan 003 did not establish per-run controllers and run-specific messages.
- A required Chrome API call cannot consume a signal and cannot be safely
  guarded before/after dispatch.
- Cancellation of an already-dispatched editor mutation cannot be represented
  honestly; document that boundary rather than claiming rollback.
- Fixing cancellation requires the MCP protocol rewrite in plan 008; preserve
  a narrow signal seam and defer protocol details.

## Maintenance notes

- Every future async operation inside a run must accept the run signal.
- Reviewers should use fake call counts to distinguish cancelled-before-effect
  from merely ignored-after-effect.
- Plan 008 must retain the timeout/parent-signal helper.
- Reviewable rollback is a future product direction, not part of cancellation.
