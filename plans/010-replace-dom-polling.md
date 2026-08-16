# Plan 010: Replace continuous whole-page polling with events

> **Executor instructions**: Execute after plan 001. Preserve the selection and
> opened-image quick-add affordances while removing the 220 ms lifetime poll.
> Do not solve stale UI by installing another frequent global scan. Update
> plan 010 in <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/content/main.js src/content/workspace.js src/background/service-worker.js manifest.json test TESTING.md</code>
> Changed injected-file order or Typst DOM heuristics require reconciliation.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: <code>plans/001-establish-verification-baseline.md</code>
- **Category**: perf
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

Every Typst page currently runs selection and image quick-add updates every
220 ms. Image updates perform workspace extraction, broad image/canvas scans,
body text reads, and layout measurements even while the user and document are
idle. This consumes CPU/battery and can contend with CodeMirror and Typst
preview rendering.

After this plan, updates are invalidated by relevant events, coalesced to
animation frames, cached between mutations, and suspended when the document is
hidden.

## Current state

- <code>src/content/main.js:612-615</code>:

  ~~~js
  setInterval(() => {
    updateSelectionFloatButton();
    updateImageFloatButton();
  }, 220);
  ~~~

- <code>src/content/main.js:584-592</code> calls
  <code>findDominantPreviewImage</code> and layout measurement on each image
  update.
- <code>src/content/main.js:224-249</code> combines workspace extraction,
  image scans, and geometry reads.
- <code>src/content/workspace.js:190-200</code> reads
  <code>document.body.innerText</code> during heuristic extraction.
- Main-world files are registered/injected in this order by
  <code>service-worker.js:52-69</code>:
  workspace, diagnostics, main.
- Existing main-world helpers use IIFEs and guarded globals such as
  <code>__typstAgentWorkspaceExtract</code>. Match this no-build pattern if a
  scheduler helper is extracted.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/float-controller.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | quick-add scenarios pass |
| Remove poll | <code>rg -n "setInterval.*220|}, 220\\)" src/content</code> | no matches |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/content/float-controller.js</code> (create)
- <code>src/content/main.js</code>
- <code>src/content/workspace.js</code> for cache-friendly extraction seams
- <code>src/background/service-worker.js</code> for injected-file order
- <code>manifest.json</code> for web-accessible/injected helper registration
- <code>test/float-controller.test.mjs</code> (create)
- <code>test/browser-smoke.test.mjs</code>
- <code>TESTING.md</code>

**Out of scope**:

- Rewriting Typst DOM heuristics wholesale.
- Adding a framework or content-script build.
- Chat rendering performance.
- Polling the full document at a slower but still frequent interval as the
  primary mechanism.
- Multi-file editing.

## Git workflow

- Branch: <code>codex/010-replace-dom-polling</code>
- Suggested commits:
  - <code>test: cover quick-add invalidation</code>
  - <code>perf: replace content polling with events</code>
- Do not push or publish.

## Steps

### Step 1: Instrument and characterize update triggers

In the local browser fixture, record calls to:

- workspace extraction;
- image enumeration;
- body text reads;
- <code>getBoundingClientRect</code>;
- selection/image button render.

Capture these scenarios:

- 5 seconds idle and visible;
- selection created/changed/cleared;
- editor typing;
- preview canvas replaced;
- file/image preview opened;
- scroll and resize;
- tab hidden then shown;
- Typst SPA route change.

The final test must assert zero broad scans during a stable idle window, not
merely fewer scans.

**Verify**: baseline instrumentation demonstrates recurring idle calls before
the fix.

### Step 2: Extract a testable invalidation scheduler

Create a small IIFE helper compatible with main-world injection. It should
provide:

- named dirty flags for selection, preview candidates, workspace, and layout;
- <code>requestAnimationFrame</code> coalescing;
- debounce for mutation bursts;
- visibility-aware suspend/resume;
- explicit cleanup for listeners/observers;
- test injection for clock, animation frame, and callbacks.

Expose only one guarded global factory, following the workspace helper pattern.
Register it before <code>main.js</code> for both dynamic injection and
registered content scripts.

**Verify**: pure Node tests prove repeated invalidations coalesce to one flush
and hidden documents do no work.

### Step 3: Drive selection UI from selection/input events

Listen to the narrowest available events:

- <code>selectionchange</code>;
- pointer/key completion events where CodeMirror updates may lag;
- editor subtree mutation only if required by the fixture.

Use one scheduled layout flush for positioning. Cache the last selection range
and button geometry so equivalent events do not write styles.

**Verify**: create/change/clear selection browser tests pass with no interval.

### Step 4: Drive image/workspace UI from targeted mutations

Identify current editor, preview, and file-panel roots using existing
heuristics. Observe only those subtrees. Rebind observers when the root is
replaced by SPA navigation.

Invalidate:

- preview candidates when relevant image/canvas children or attributes change;
- workspace snapshot when file-panel/path text changes;
- layout on scroll/resize.

Cache the workspace snapshot and dominant-image candidate until the matching
dirty flag changes. Do not read <code>body.innerText</code> on scroll/resize
alone.

Use a very low-frequency recovery probe only if browser tests demonstrate a
Typst state transition with no observable event. It must be at least several
seconds, disabled while hidden, and must not perform broad work unless a cheap
root/version check changes.

**Verify**: preview/file/SPA tests pass and the idle broad-scan counter stays
zero.

### Step 5: Prevent layout thrashing

Separate each flush into:

1. DOM reads and candidate calculation;
2. button DOM/style writes.

Avoid measuring a button immediately after changing its display unless the
measurement is unavoidable and covered by one frame. Preserve viewport
clamping.

**Verify**: the instrumentation test asserts at most one grouped layout phase
per animation frame during a burst.

### Step 6: Update performance QA

Document event triggers, the optional recovery probe if any, hidden-tab
behavior, and a DevTools performance check for idle CPU. Keep real typst.app
manual checks for selection, canvas preview, opened image, and route changes.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Pure scheduler coalescing, dirty-flag, cleanup, and visibility tests.
- Browser selection create/change/clear.
- Preview canvas/image replacement and file-panel mutation.
- Scroll/resize reposition without workspace rescan.
- SPA root replacement and observer rebinding.
- Hidden tab produces no scan; resume refreshes once.
- Stable five-second idle window performs zero broad scans.

## Done criteria

- [ ] The 220 ms interval is removed.
- [ ] Stable visible idle performs zero workspace/image broad scans.
- [ ] Hidden documents perform no quick-add work.
- [ ] Selection, preview, opened image, scroll, resize, and SPA transitions
  update correctly.
- [ ] Mutation bursts coalesce to bounded frame/debounce work.
- [ ] Workspace/image candidates are cached until relevant invalidation.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 010 is marked DONE.

## STOP conditions

Stop and report if:

- A required Typst UI change emits no observable selection, mutation,
  navigation, scroll, resize, or visibility signal.
- Registered main-world injection cannot load the helper before
  <code>main.js</code> consistently.
- Correctness would require a frequent full-document recovery poll.
- Tests require coupling to a private Typst selector more brittle than current
  heuristics without a fallback.

## Maintenance notes

- New workspace/image heuristics must declare which dirty flag invalidates
  them.
- Reviewers should inspect idle traces, not only interactive correctness.
- Keep observer scopes narrow; observing <code>document.body</code> with
  subtree true and broad rescans on every mutation recreates the problem.
- Path-aware multi-file direction work must reuse the cache/invalidation model.
