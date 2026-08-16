# Plan 015: Make snapshot recovery scope-safe, bounded, and fully tested

> **Executor instructions**: Follow every step and verification gate. Touch
> only in-scope files. Stop on any listed condition rather than weakening
> recovery guarantees. The reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/background/agent.js src/background/document-snapshots.js src/background/edit-preview.js src/sidepanel/snapshot-controller.js test`
> The audited live tree is intentionally ahead of the stamped commit; compare
> the excerpts below. Changed snapshot identity, restore confirmation, or diff
> semantics are a STOP condition until reconciled.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plan 014
- **Category**: bug, security, perf, tests, tech-debt
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

Terminal snapshot maintenance reads whichever document is live in the captured
tab but stores it under the run's original project/session without revalidating
the tab URL or file identity. A late file/project switch can therefore mislabel
recovery data. Separately, the retained-frontier Myers implementation can
allocate millions of map entries before its fallback, and the restore UI state
machine has almost no direct test coverage. This plan fixes all three together
because safe fallback behavior must be verified through the UI that consumes
it.

## Current state

- `src/background/agent.js:243-287` reads live text and creates/invalidate
  snapshots using `run.projectId` and `run.sessionId` without checking
  `run.tabUrl`, `run.signal`, or equality with `run.activeEditorFile`.
- `src/background/agent.js:1052-1066` performs terminal snapshot work after
  transcript persistence, including cancellation/error cleanup.
- `src/background/edit-preview.js:232-262` stores every Myers frontier `Map`
  through edit distance 4,000. Its changed-text cap is evaluated only after
  operations have been built.
- `src/background/document-snapshots.js:43-68` passes full current and saved
  documents directly into `buildUnifiedDiff`; snapshot text may be up to the
  one-million-character editor transaction limit.
- `src/sidepanel/snapshot-controller.js:198-345` owns preview, scope
  revalidation, confirmation, context persistence, retry, and failure UI.
  `test/sidepanel-controllers.test.mjs` currently tests only its date formatter.
- Existing restore behavior saves a rescue copy before applying and allows a
  restore when a complete diff is unavailable. Preserve that explicit warning
  and rescue invariant; do not claim the user reviewed a missing diff.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/document-snapshots.test.mjs test/edit-preview.test.mjs test/sidepanel-controllers.test.mjs test/agent-integration.test.mjs` | all pass |
| Full verification | `npm run verify` | exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 and restore confirmation exercised |
| Import boundaries | `npm run check:imports` | no cycles/layer violations |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/background/agent.js`
- `src/background/run-snapshot-maintenance.js` (create)
- `src/background/document-snapshots.js`
- `src/background/edit-preview.js`
- `src/shared/constants.js`
- `src/sidepanel/snapshot-controller.js`
- `test/agent-integration.test.mjs`
- `test/document-snapshots.test.mjs`
- `test/edit-preview.test.mjs`
- `test/sidepanel-controllers.test.mjs`
- `test/browser/smoke.test.mjs`
- `scripts/check-coverage.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Changing snapshot retention counts or storage schema.
- Automatically restoring without explicit confirmation.
- Removing rescue snapshots or allowing restore into a different file.
- Introducing a heavyweight diff dependency without evidence and review.
- General session-controller or storage decomposition (plans 020–021).

## Git workflow

- Branch: `codex/015-safe-snapshot-recovery`
- Suggested commits:
  - `test: cover snapshot scope and restore UI`
  - `fix: bound snapshot diff work`
  - `refactor: isolate run snapshot maintenance`
- Do not push or merge into the user's branch.

## Steps

### Step 1: Add scope and UI characterization tests

Add deterministic cases for:

- run completes after its tab navigates to another Typst project;
- run completes after the active file changes, including the same basename in
  a different path;
- cancellation/error maintenance after either scope change;
- successful restore confirmation and context-event persistence;
- no-change preview disables confirmation;
- active tab/project/session changes while the dialog is open;
- preview/restore request failure and retry button recovery;
- restore succeeds but chat-context persistence fails and shows a warning;
- diff-unavailable preview remains explicit and rescue-before-restore still
  occurs.

Use injected requests/status callbacks and the small DOM fake style already in
`test/sidepanel-controllers.test.mjs`. Add one packaged-browser confirmation
that clicks `.snapshot-restore-action`, not only list/delete controls.

**Verify**: focused tests reproduce the missing scope checks and exercise the
controller branches before implementation.

### Step 2: Introduce a total diff-work budget

Replace the distance-only retained-trace guard with a measurable aggregate
budget that is checked before retaining each frontier. At minimum bound:

- total frontier entries retained;
- total loop/frontier work;
- changed preview text;
- input line count or another preallocation proxy.

Return the existing structured `EDIT_PREVIEW_TOO_LARGE` fallback before memory
can grow excessively. Prefer a bounded Myers trace or linear-space algorithm;
do not substitute a quadratic dynamic-programming matrix. Export or inject a
small operation counter for deterministic tests rather than using wall-clock
thresholds.

Test disjoint 2,000-line editor edits and substantially rewritten large
snapshots. Assertions must prove the work counter stays under the chosen bound
and fallback is stable. Document the bound in `LIMITS` if it is shared policy.

**Verify**: `node --test test/edit-preview.test.mjs test/document-snapshots.test.mjs`
passes adversarial cases without large timing variance.

### Step 3: Revalidate terminal snapshot identity

Before every automatic snapshot read/create/invalidate:

1. Throw on `run.signal` abort where creation should not continue.
2. Fetch and compare the exact current tab URL with captured `run.tabUrl`.
3. Read the active file and require exact normalized relative-path equality
   with `run.activeEditorFile`.
4. Require the live context to identify a text editor before hashing text.
5. On mismatch, skip maintenance and return a bounded warning; never relabel
   the live file under the originating run.

Cancellation/error invalidation must also be scoped. A skipped maintenance
operation must not change the already-completed assistant response status.

**Verify**: project/file-switch integration tests show zero snapshot storage
mutations and a bounded warning where user-visible.

### Step 4: Extract run snapshot maintenance from `agent.js`

Create `run-snapshot-maintenance.js` with an injected adapter interface for tab
lookup/context messaging, hashing, and snapshot storage. Move only:

- live snapshot state validation;
- completed-response automatic snapshot creation;
- divergence invalidation;
- bounded warning construction.

Keep orchestration in `agent.js`: it calls the module at start, terminal
completion, and error/cancellation boundaries. The module must not import the
provider, tool registry, or side-panel code. This extraction should remove the
current snapshot helper cluster from `agent.js` and have focused tests.

**Verify**: import checks pass and agent integration behavior remains identical
for correctly scoped runs.

### Step 5: Raise dangerous-controller coverage and finish browser QA

Add a named coverage floor for `snapshot-controller.js` high enough to cover
its restore state machine rather than only formatting helpers. A reasonable
initial floor is 70% lines, but set the exact floor from the meaningful tests
added—not by excluding branches.

Update `TESTING.md` with scope-switch and no-diff restore cases and
`ARCHITECTURE.md` with the extracted maintenance owner.

**Verify**: full verification, packaged browser smoke, and diff hygiene pass.

## Test plan

- Deterministic diff work-budget success and fallback.
- Project/file/tab scope mismatch at start, completion, cancellation, error.
- Exact relative path, including same basename in different directories.
- Restore UI success, no-op, stale scope, request failure, context warning,
  unavailable diff, and focus cleanup.
- Browser confirmation proves rescue copy precedes actual page mutation.

## Done criteria

- [ ] No automatic snapshot is created or invalidated after tab/project/file
      identity drifts.
- [ ] Every terminal maintenance path honors scope and cancellation.
- [ ] Diff work is aggregate-budgeted before excessive trace retention.
- [ ] Worst-case deterministic tests stay within the declared budget.
- [ ] Restore UI success and failure states have direct controller tests.
- [ ] Packaged smoke confirms one real restore flow and rescue behavior.
- [ ] Snapshot maintenance has a focused background module and `agent.js`
      contains only orchestration calls.
- [ ] Focused/full tests, browser smoke, import checks, and diff hygiene pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Typst context cannot provide exact active-file identity at the terminal
  boundary; safe behavior is to skip, not guess.
- A proposed diff algorithm has no deterministic memory/work bound.
- The restore UI would apply when the user was shown neither a complete diff
  nor the existing explicit warning/rescue guarantee.
- Extraction creates a background-to-content or background-to-sidepanel layer
  violation.

## Maintenance notes

- New restore types must reuse exact scope validation and rescue-first
  semantics.
- Reviewers should inspect the no-diff path closely; fallback must be honest.
- Keep performance tests operation-count based so CI hardware does not make
  them flaky.
