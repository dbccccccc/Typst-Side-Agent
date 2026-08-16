# Plan 018: Bound streaming render and Typst DOM observation work

> **Executor instructions**: Follow each step and run every gate. Preserve the
> single sanitized Markdown boundary and event-driven controller design. Touch
> only in-scope files. The reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/sidepanel/chat.js src/content/float-controller.js src/content/main.js src/content/workspace.js test`
> Compare the excerpts below with the live tree. Changed sanitizer policy,
> stream segment ordering, or quick-add ownership is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 014 and 017
- **Category**: perf, tech-debt, tests
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

Frame batching reduced per-token UI messages, but each dirty frame still parses,
sanitizes, and replaces the complete accumulated Markdown prefix. Long outputs
therefore retain growing-prefix/quadratic work. The main-world observer also
watches a generic `main` subtree that contains CodeMirror in the canonical
fixture; editor child/class mutations can invalidate broad workspace caches and
trigger whole-page scans. This plan makes both hot paths proportional to new
work and extracts the streaming state machine from the 1,291-line `chat.js`.

## Current state

- `src/sidepanel/chat.js:59-90` is the sole untrusted Markdown-to-DOM boundary:
  Marked output passes through a strict DOMPurify allowlist and URL validation.
  Preserve that exact security boundary.
- `src/sidepanel/chat.js:884-909` calls `renderMarkdownInto()` with all of
  `state.stream.currentText` on every dirty animation frame.
- `src/sidepanel/chat.js:928-936` grows that string for each chunk; provider
  output may be about one MiB.
- `src/content/float-controller.js:67-80` observes generic `main,[role=main]`
  with `childList`, subtree, and class/src/selection attributes and invalidates
  both preview and workspace.
- `src/content/main.js:1101-1105` clears broad caches and updates the image
  affordance for those flags; `workspace.extract()` reads `body.innerText` and
  performs broad DOM scans.
- `test/stream-batching.test.mjs` covers background transport batching, not
  side-panel parser work. `test/float-controller.test.mjs` dispatches `input`
  but does not invoke realistic mutation-observer callbacks.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/stream-batching.test.mjs test/chat-checkpoint.test.mjs test/float-controller.test.mjs test/workspace.test.mjs test/static.test.mjs` | all pass |
| Full verification | `npm run verify` | exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 and long-stream scan counters bounded |
| Import boundaries | `npm run check:imports` | no cycles/layer violations |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/sidepanel/chat.js`
- `src/sidepanel/stream-renderer.js` (create)
- `src/sidepanel/markdown-renderer.js` (create only if extraction keeps one
  sanitizer boundary clearer than a callback interface)
- `src/sidepanel/state.js`
- `src/content/float-controller.js`
- `src/content/main.js`
- `src/content/workspace.js` only for explicit root discovery/instrumentation
- `test/stream-batching.test.mjs`
- `test/chat-checkpoint.test.mjs`
- `test/float-controller.test.mjs`
- `test/workspace.test.mjs`
- `test/static.test.mjs`
- `test/browser/smoke.test.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Removing DOMPurify, widening allowed tags/attributes, or rendering raw HTML.
- Chat-history virtualization or redesigning message cards.
- Reintroducing whole-page polling or a fixed periodic timer.
- A CSS rewrite or framework migration.
- Changing provider stream framing/batching unless a failing exact-order test
  proves it necessary.

## Git workflow

- Branch: `codex/018-bound-rendering-work`
- Suggested commits:
  - `test: measure streamed render work`
  - `perf: render streaming markdown in bounded work`
  - `perf: scope Typst DOM observers`
- Do not push or merge into the user's branch.

## Steps

### Step 1: Add deterministic work counters and realistic observer tests

Introduce test-only injected hooks/counters rather than wall-clock assertions:

- number of Markdown parses/sanitizations;
- cumulative characters passed to the Markdown renderer;
- full workspace extraction count;
- observer callback records and resulting dirty flags.

Stream many small chunks across content/reasoning/tool boundaries and assert
exact final text/segments plus a linear cumulative-render bound. In the float
controller fake, retain observer callbacks and invoke records for CodeMirror,
preview, Files panel, root replacement, and unrelated shell mutations.

**Verify**: focused tests expose full-prefix reparsing and editor-triggered
workspace invalidation before implementation.

### Step 2: Extract a focused streaming renderer

Create `stream-renderer.js` with injected DOM/render/scroll/frame operations.
It should own:

- current content/reasoning segment state;
- dirty-frame scheduling and cancellation;
- append/close/tool-boundary transitions;
- near-bottom follow behavior;
- terminal flush/finalization.

Keep static message cards, tool approval controls, checkpoint/revert UI, and
history interpretation in `chat.js`. Move code only with a named interface and
focused tests; avoid a generic utility module.

**Verify**: stream tests import the controller directly and `chat.js` delegates
without duplicating the old state machine.

### Step 3: Make cumulative Markdown work linear

Use one safe strategy and document it:

- render the active unfinished content segment as plain text while streaming,
  then perform one sanitized Markdown render when that segment closes or the
  response terminates; or
- retain completed blocks and reparse only a bounded unfinished Markdown tail.

The first strategy is preferred unless a focused UX requirement proves live
formatting is necessary. In either case:

- final/static output must use the existing Marked + DOMPurify boundary;
- hostile Markdown must never become active during the streaming phase;
- reasoning remains text-only;
- content/reasoning/tool segment order remains exact;
- a terminal cancellation/error still renders already-received text safely;
- cumulative parsed characters for an N-character single segment must be O(N)
  with a machine-checkable bound.

**Verify**: parser-call/character tests and hostile browser smoke pass.

### Step 4: Observe explicit Typst roots and ignore the editor

Replace the generic preview-root observer with:

- a shallow shell observer that notices replacement of explicit roots;
- a preview observer attached only to the actual preview root;
- a Files panel observer attached only to the tree/detail root needed by
  workspace quick-add;
- an explicit filter that ignores records within `.cm-editor` and other known
  editor-owned subtrees.

When Typst replaces a root, disconnect/rebind exactly once. Do not cache stale
elements. Selection/input listeners may continue invalidating selection/layout,
but typing must not request preview/workspace scans unless an explicit preview
or Files mutation also occurs.

**Verify**: realistic observer tests show CodeMirror mutations cause no
workspace flag, while preview/file/root replacement produces one coalesced
refresh.

### Step 5: Measure the packaged path and document ownership

Extend the local fixture/browser smoke with a long streamed response and an
editing burst. Expose counters only through fixture/test hooks, never shipped
diagnostic UI. Assert bounded parse and workspace-scan counts without timing
thresholds.

Update architecture docs for the extracted stream renderer and explicit root
observers. Update testing docs with the work-count gates.

**Verify**: full verification, browser smoke, import checks, and diff hygiene
pass.

## Test plan

- Thousands of chunks, one content segment, bounded total parsed characters.
- Multiple content/reasoning/tool segments and terminal cancellation/error.
- Hostile Markdown during stream and after final sanitized render.
- Scroll-follow near/far bottom and frame cancellation cleanup.
- CodeMirror child/class mutation, preview image mutation, Files tree mutation,
  shell root replacement, hidden/visible transitions, stop/disconnect.
- Packaged fixture counters for long stream plus typing burst.

## Done criteria

- [ ] Streamed Markdown parse/sanitize work is linear in received content.
- [ ] Final output still crosses exactly one Marked + DOMPurify boundary.
- [ ] Exact segment order, cancellation, and scroll-follow behavior are tested.
- [ ] `chat.js` delegates streaming state to a focused module with no duplicate
      implementation.
- [ ] Editor mutations do not invalidate preview/workspace caches.
- [ ] Preview/Files/route/root changes still refresh the correct affordances.
- [ ] Observers, frames, timers, and listeners clean up deterministically.
- [ ] Focused/full tests, browser smoke, import checks, and diff hygiene pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Linear rendering requires bypassing or weakening the sanitizer boundary.
- Typst provides no discoverable stable preview/Files roots and safe filtering
  would make quick-add stale; report fixture evidence rather than observing all
  of `main` again.
- Exact segment ordering cannot be retained by the proposed extraction.
- A test relies on wall-clock performance rather than operation counts.

## Maintenance notes

- Future streaming formatting must keep the cumulative-work assertion.
- New observed Typst surfaces need a named root and mutation class; do not widen
  the generic shell observer without a fixture/test.
- Keep the streaming controller DOM-focused and independent of provider wire
  parsing.
