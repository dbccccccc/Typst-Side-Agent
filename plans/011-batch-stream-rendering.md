# Plan 011: Batch stream transport and rendering work

> **Executor instructions**: Execute after plans 003 and 005. Preserve exact
> ordering between reasoning, text, tool calls, tool results, and terminal
> events. Every final text render must still pass through plan 005's sanitizer.
> Update plan 011 in <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/agent.js src/sidepanel/chat.js src/sidepanel/app.js src/sidepanel/state.js src/shared test TESTING.md</code>
> Changed run-event or safe-renderer contracts are a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**:
  <code>plans/003-isolate-agent-runs.md</code>,
  <code>plans/005-sanitize-chat-rendering.md</code>
- **Category**: perf
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

Every provider delta currently becomes a runtime message. Each text delta is
appended to an accumulated string, the entire string is parsed as Markdown,
the whole content element is replaced, and the panel is forced to the bottom.
Cost grows with response length and chunk count, producing avoidable runtime
traffic, repeated parsing, DOM reconstruction, and layout work.

After this plan, adjacent deltas are coalesced at a bounded cadence, ordering
is explicit, sanitized Markdown renders at most once per frame/cadence, and
autoscroll respects users reading earlier content.

## Current state

- <code>src/background/agent.js:404-413</code> broadcasts every content and
  reasoning delta immediately.
- <code>src/sidepanel/app.js:640-651</code> forwards each event directly to
  chat functions.
- <code>src/sidepanel/chat.js:393-401</code>:

  ~~~js
  state.stream.currentText += chunk;
  state.stream.allText += chunk;
  state.stream.currentContentEl.innerHTML =
    renderMarkdown(state.stream.currentText);
  scrollToBottom();
  ~~~

- Reasoning, tool calls/results, and preflight updates also force scroll.
- Plan 003 adds run IDs; plan 005 replaces unsafe HTML rendering. Use those
  final APIs rather than restoring the excerpts above.

## Performance contract

- Background flush cadence: no more than one batched run event per 32 ms under
  continuous same-channel deltas.
- UI render cadence: no more than one Markdown parse/DOM update per animation
  frame and no more than one forced scroll decision per frame.
- Flush pending deltas synchronously before a tool-call, tool-result, error,
  cancel, or done event so ordering remains exact.
- Preserve first-byte visibility; do not wait for stream completion.
- Autoscroll only when the viewport was already within a tested threshold of
  the bottom before the update.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/stream-batching.test.mjs test/agent-integration.test.mjs test/chat-security.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | long/fast stream scenarios pass |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/background/stream-batcher.js</code> (create)
- <code>src/background/agent.js</code>
- <code>src/sidepanel/chat.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/state.js</code>
- <code>test/stream-batching.test.mjs</code> (create)
- <code>test/agent-integration.test.mjs</code>
- <code>test/chat-security.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>TESTING.md</code>

**Out of scope**:

- Chat-history virtualization.
- Changing Markdown policy or sanitizer allowlists.
- Provider wire-format changes.
- Reordering model tool calls.
- Storage summarization.

## Git workflow

- Branch: <code>codex/011-batch-stream-rendering</code>
- Suggested commits:
  - <code>test: measure streamed render batching</code>
  - <code>perf: batch stream messages and markdown renders</code>
- Do not push or publish.

## Steps

### Step 1: Add deterministic ordering and work-count tests

Build a fake stream containing:

- thousands of one-character content deltas;
- reasoning then content transitions;
- alternating adjacent channels;
- tool calls and results between text segments;
- completion and error with pending deltas.

Record:

- runtime messages emitted;
- Markdown parses;
- DOM replacements;
- scroll decisions;
- final segment order/content.

Use fake clocks and animation frames. Avoid timing assertions based on wall
clock sleeps.

**Verify**: baseline tests demonstrate one message/parse per delta before the
fix.

### Step 2: Coalesce adjacent background deltas

Create a pure/order-preserving batcher:

- queue records with channel and text;
- merge only adjacent records of the same channel;
- schedule one flush at the configured cadence;
- provide immediate <code>flush</code> and <code>cancel</code>;
- tag emitted batches with run ID from plan 003;
- never merge across a tool/terminal boundary.

In <code>agent.js</code>, use one batcher per run. Flush before
<code>AI_TOOL_CALLS</code>, each tool-result boundary where visible ordering
matters, done, error, and cancel. Cleanup timers in the run's
<code>finally</code>.

**Verify**: 1,000 adjacent character deltas produce a bounded number of
background messages while final text remains exact.

### Step 3: Schedule side-panel renders

Change append functions to:

- update run-local text/reasoning state immediately;
- mark the current segment dirty;
- schedule one animation-frame render;
- flush pending rendering before tool blocks or terminal state;
- use plan 005's safe renderer once per dirty text segment.

Do not rebuild earlier completed segments. Keep a stable DOM node for the
current live segment and replace only its safe contents.

**Verify**: parse/DOM counters are bounded by animation frames, not deltas.

### Step 4: Preserve scroll position intentionally

Before DOM mutation, compute whether the message viewport is near the bottom
using a small named threshold. After mutation:

- scroll to bottom only if it was near bottom;
- preserve the user's reading position otherwise;
- expose a subtle “new content” affordance or reuse an existing suitable
  pattern so the user can jump back down.

Tool/preflight/reasoning updates must use the same policy.

**Verify**: browser tests cover near-bottom auto-follow and scrolled-up
preservation.

### Step 5: Flush and clean up every terminal path

On done:

1. Flush background batch.
2. Deliver done.
3. Flush UI render.
4. Persist final segments.

On error/cancel:

1. Flush only deltas already received before the terminal event.
2. Cancel scheduled timers/frames.
3. Render terminal state once.
4. Prevent any later queued callback from mutating the run.

**Verify**: no dropped/duplicated text and no post-terminal update in focused
tests.

### Step 6: Add performance QA thresholds

Document a reproducible local mock that emits at least 5,000 small chunks.
Record expected bounds from the Performance contract and add assertions where
deterministic. Include a manual DevTools check for a long response while the
user scrolls upward.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Pure batcher merge/order/flush/cancel tests.
- Run-ID isolation for simultaneous streams.
- Reasoning/text/tool boundary order.
- Done/error/cancel with pending work.
- Work counters for 1,000 and 5,000 chunks.
- Sanitizer called on every rendered text update.
- Near-bottom versus scrolled-up behavior.
- No callback after run cleanup.

## Done criteria

- [ ] Adjacent provider deltas are batched to the documented cadence.
- [ ] Tool and terminal boundaries flush in exact order.
- [ ] Markdown parsing/DOM replacement is frame-bounded.
- [ ] Completed prior segments are not reparsed for new chunks.
- [ ] Scrolled-up users are not forced to the bottom.
- [ ] Final persisted text/segments exactly match the input stream.
- [ ] No post-terminal callback updates the UI.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 011 is marked DONE.

## STOP conditions

Stop and report if:

- Plan 003 events do not identify runs.
- Plan 005 exposes no safe way to replace/append rendered content.
- Provider semantics require a visible boundary not represented in the queued
  channel model.
- Batching causes a measurable first-token delay above the 32 ms contract.
- Preserving scroll position requires a full chat virtualization redesign.

## Maintenance notes

- Any new stream event must document whether it flushes pending deltas.
- Keep performance tests deterministic and counter-based.
- Review sanitizer and batching together after renderer upgrades.
- Storage plan 009 owns persisted size; this plan owns only runtime/UI work.
