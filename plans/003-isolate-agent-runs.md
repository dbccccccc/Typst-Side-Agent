# Plan 003: Bind every agent run to its originating tab and session

> **Executor instructions**: Execute after plan 001. Read this file completely
> before editing. Preserve partial user/assistant history on cancellation and
> never redirect a page tool to the currently focused tab. Update plan 003 in
> <code>plans/README.md</code> when all gates pass.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/agent.js src/background/service-worker.js src/sidepanel/app.js src/sidepanel/state.js src/content/isolated.js src/content/main.js src/shared test</code>
> A changed stream lifecycle, session-save path, or message shape is a STOP
> condition until the plan is reconciled.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: <code>plans/001-establish-verification-baseline.md</code>
- **Category**: bug
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The service worker currently resolves the active tab at the moment each tool
runs, not the tab that started the request. Stream events are extension-wide,
one global controller represents every panel, and the side panel saves through
whatever session is current when an event arrives. Switching Typst tabs,
sessions, or windows during a run can therefore edit one project and save the
answer into another.

After this plan, every event, tool operation, cancellation, and persistence
write has one immutable run identity and one immutable target tuple:
<code>runId + tabId + projectId + sessionId</code>.

## Current state

- <code>src/background/agent.js:8-12</code>:

  ~~~js
  let activeController = null;
  function broadcast(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  ~~~

- <code>src/background/agent.js:139-144</code> queries
  <code>{ active: true, currentWindow: true }</code> for every forwarded page
  operation.
- <code>src/background/agent.js:566-568</code> aborts the prior global
  controller whenever any new run starts.
- <code>src/sidepanel/app.js:498-504</code> sends
  <code>AI_STREAM_START</code> without a run, tab, project, or session ID.
- <code>src/sidepanel/app.js:640-654</code> accepts every
  <code>AI_STREAM_*</code> and <code>AI_TOOL_*</code> event without
  correlation.
- <code>src/sidepanel/app.js:214-221</code> can switch the global current
  session while a run is active.
- <code>src/sidepanel/app.js:269-271</code> saves
  <code>state.chatHistory</code> to <code>state.currentSession.id</code>.
- Current naming style uses uppercase string message types, plain objects, and
  native ESM. Preserve that style; do not add a framework.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/run-routing.test.mjs test/agent-integration.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | exit 0 |
| Search old global controller | <code>rg -n "activeController|getTypstTab" src/background/agent.js</code> | no obsolete global routing matches |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/shared/protocol.js</code> (create a minimal run envelope; plan 012
  will expand it)
- <code>src/background/agent.js</code>
- <code>src/background/service-worker.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/state.js</code>
- <code>src/content/isolated.js</code> and <code>src/content/main.js</code> only
  where request/run correlation must cross the page bridge
- <code>test/run-routing.test.mjs</code> (create)
- <code>test/agent-integration.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>TESTING.md</code> for new multi-tab/multi-window QA

**Out of scope**:

- General consolidation of every message type; plan 012 owns that refactor.
- Tool argument validation or approval policy.
- Storage-schema migration; use existing session APIs with explicit IDs.
- Multi-file Typst editing.
- Changing provider request formats.

## Git workflow

- Branch: <code>codex/003-isolate-agent-runs</code>
- Suggested commits:
  - <code>test: characterize multi-run routing</code>
  - <code>fix: bind agent runs to origin context</code>
- Do not push or open a PR unless instructed.

## Target invariant

Define and enforce this immutable start envelope:

~~~js
{
  type: 'AI_STREAM_START',
  runId,
  tabId,
  projectId,
  sessionId,
  messages,
  settings,
  modelConfig,
  attachments
}
~~~

Every event caused by that run must carry the same <code>runId</code>. Every
page-bound request must target the captured numeric <code>tabId</code>.
Cancellation must name one <code>runId</code>. No code may infer a run target
from the currently active browser tab or current side-panel session.

## Steps

### Step 1: Characterize the cross-tab and cross-panel failures

Using the fakes from plan 001, add failing regression cases for:

- start on tab A, activate tab B, then execute a page edit;
- start in session A, switch the UI to session B, then receive stream
  completion;
- start independent runs from two windows;
- cancel one run while another continues;
- deliver an event for an unknown/stale run to a panel.

Before the fix, tests should demonstrate the wrong target or global
cancellation. Commit the tests together with the fix or keep them failing only
on the branch; do not weaken assertions to match current behavior.

**Verify**: the focused test file loads and its failure messages name the
incorrect tab/session behavior.

### Step 2: Introduce a minimal shared run envelope

Create <code>src/shared/protocol.js</code> with:

- run-event type constants used by background and side panel;
- <code>createRunId()</code> using <code>crypto.randomUUID()</code>;
- pure validators for run start, run event, and cancel envelopes;
- a builder that always includes <code>runId</code>.

Validation must reject missing/empty run IDs, nonnumeric tab IDs, and empty
project/session IDs before any model request starts.

Keep this module deliberately small. Plan 012 will consolidate non-run message
families later.

**Verify**: add pure protocol tests and run
<code>node --test test/run-routing.test.mjs</code>.

### Step 3: Capture origin identity in the side panel

At send time:

1. Resolve the current tab once.
2. Capture its numeric ID, current project ID, and current session ID.
3. Generate a run ID.
4. Store a run-local UI record rather than relying on mutable global
   <code>state.currentSession</code> and <code>state.chatHistory</code>.
5. Send the complete immutable start envelope.

The run-local record must own its accumulated message/segments and original
session ID. Event handlers must ignore messages whose run ID is not known to
that panel. An event for a known run that is no longer visible may update and
persist that run, but must not render into another session.

When tab/project/session navigation occurs, either:

- keep the run alive in a detached run record and route it to the original
  tab/session, or
- cancel that exact run and persist its partial result to the original
  session before switching.

Choose one behavior and document it in <code>TESTING.md</code>; never save
partial output into the newly selected session.

**Verify**: the session-switch regression test passes.

### Step 4: Replace the global controller with a per-run registry

In <code>agent.js</code>, replace <code>activeController</code> with a
<code>Map</code> keyed by run ID. Each entry must contain at least:

- controller,
- tab ID,
- project ID,
- session ID,
- start timestamp.

Starting run B must not abort run A. Duplicate active run IDs must be rejected.
Run cleanup must occur in <code>finally</code> and must remove only the matching
entry.

Change page-tool helpers to accept a captured tab ID and use
<code>chrome.tabs.sendMessage(tabId, ...)</code>. Remove the active-tab lookup
from the agent tool path.

Every broadcast from agent code must include the run ID. Run-scoped preflight
waiters must use a composite key or nested map so identical provider call IDs
cannot collide across runs.

**Verify**: the two-window and tab-switch tests pass.

### Step 5: Make cancellation and service-worker routing run-specific

Change <code>AI_STREAM_CANCEL</code> to require a run ID. The service worker
must validate the sender envelope and cancel only that registry entry. Return
an explicit not-found result for a stale run; do not cancel all runs.

Keep global emergency cancellation out of the public message protocol. If it
is needed for extension shutdown, implement it as an internal cleanup helper.

Ensure content bridge requests carry a request ID and, where applicable, run
ID so simultaneous calls cannot satisfy each other's listeners.

**Verify**: cancel-one-of-two and simultaneous-page-request tests pass.

### Step 6: Extend browser QA

Add automated or manual cases:

- two Typst tabs in one window;
- two windows, each with its side panel;
- switch active tab while a model is about to edit;
- switch chat session during a response;
- cancel one panel while the other streams.

Assert no edit or response crosses its captured origin.

**Verify**: <code>npm run test:browser</code> and
<code>npm run verify</code> exit 0.

## Test plan

- Create <code>test/run-routing.test.mjs</code> using fake tabs/runtime/storage
  from plan 001.
- Assert exact numeric target tab IDs, not only message counts.
- Assert persisted session IDs and final message content.
- Cover unknown, duplicate, completed, and cancelled run IDs.
- Cover cleanup after provider error.
- Extend the packaged browser smoke with at least a tab-switch case using
  local fixtures.

## Done criteria

- [ ] No page tool in <code>agent.js</code> queries the active tab.
- [ ] Every start, stream, tool, preflight, done, error, and cancel message is
  correlated by run ID.
- [ ] Starting one run does not abort another.
- [ ] Switching tabs cannot redirect an edit.
- [ ] Switching sessions cannot redirect persistence or rendering.
- [ ] Cancelling one run leaves other runs active.
- [ ] Unknown/stale run events are ignored safely and tested.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 003 is marked DONE.

## STOP conditions

Stop and report if:

- A reliable numeric tab ID cannot be captured when the side panel sends.
- Chrome delivers no way to distinguish the originating side-panel/window
  context in the tested runtime.
- Correct persistence requires the plan 009 storage migration rather than an
  explicit existing <code>SESSION_UPDATE</code> by ID.
- Existing provider behavior depends on one global run and cannot be preserved
  without a product decision.
- Any fix falls back to locking all windows globally instead of establishing
  run identity.

## Maintenance notes

- Any new event added before plan 012 must carry a run ID if it belongs to a
  run.
- Reviewers should trace one test end-to-end from start envelope to targeted
  tab call and targeted session save.
- Plan 006 will extend each run entry with unified cancellation.
- Plan 012 must extend, not replace, the protocol and correlation invariants
  established here.
