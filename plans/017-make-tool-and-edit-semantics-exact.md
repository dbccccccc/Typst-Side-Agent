# Plan 017: Make tool ordering, file-tree, and edit semantics exact

> **Executor instructions**: Follow the plan in order and run every gate.
> Preserve fail-closed validation and user approval boundaries. Touch only the
> in-scope files and stop on any listed condition. The reviewer maintains the
> tracker index.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/background/agent.js src/background/edit-preview.js src/background/tools.js src/content/bridge-protocol.js src/content/main.js src/content/workspace.js src/shared/project-tree.js src/shared/protocol.js test`
> The plan targets the audited live worktree. A changed tool-batch contract,
> editor payload, or project-tree shape is a STOP condition until reconciled.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 014 and 016
- **Category**: bug, tech-debt
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

The current global priority sort can move every `open_project_file` ahead of
the reads/edits that depended on an earlier open, silently retargeting work to
the wrong file. The project-tree result can say `complete: true` while retaining
unknown rows, empty `replace_lines` leaves blank lines instead of deleting the
range, and auto-approved edits report that a diff was reviewed. These are small
surface errors around the project's most important promise: exact, reviewable
changes to the intended Typst file.

## Current state

- `src/background/agent.js:898-913` assigns priorities to whole tool types;
  all opens sort before all document operations. The execution loop at
  `1032-1046` then runs that order while returning results by original call ID.
- `executeOpenProjectFile()` mutates `run.activeEditorFile`, so a batch
  `open A, read A, open B, read B` currently becomes `open A, open B, read B,
  read B`.
- `src/content/workspace.js:356-410` deliberately emits `kind: 'unknown'` when
  the folder glyph or a no-extension row cannot be classified.
- `src/background/agent.js:592-607` calls the tree complete when it is not
  truncated and has no collapsed folders, ignoring unknown entries.
- `src/background/edit-preview.js:132-142` replaces only line text; the
  `lineRange()` endpoint at `314-325` excludes the newline. The tool contract
  says `new_content: ""` deletes the range.
- `src/content/main.js:625-633` always returns `reviewed_diff: true`, including
  the auto-approval path in `agent.js:1098-1103`.
- Existing tests cover diagnostics-last and bottom-up line batches, but not
  interleaved file opens, unknown completeness, empty deletion boundaries, or
  the meaning of the reviewed flag.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/agent.test.mjs test/agent-integration.test.mjs test/edit-preview.test.mjs test/project-tree.test.mjs test/workspace.test.mjs test/main-world-recovery.test.mjs test/protocol.test.mjs test/bridge-protocol.test.mjs test/document-snapshots.test.mjs test/edit-revert.test.mjs` | all pass |
| Full verification | `npm run verify` | exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 |
| Import boundaries | `npm run check:imports` | no cycles/layer violations |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/background/agent.js`
- `src/background/document-snapshots.js` solely to mark its non-tokenized
  restore apply conservatively unreviewed
- `src/background/edit-revert.js` solely to mark checkpoint revert applies
  unreviewed
- `src/background/tool-execution-plan.js` (create)
- `src/background/edit-preview.js`
- `src/background/tools.js`
- `src/content/bridge-protocol.js` solely to exact-validate and forward the
  worker-controlled reviewed-diff bit
- `src/content/main.js`
- `src/content/workspace.js`
- `src/shared/project-tree.js`
- `src/shared/protocol.js`
- `src/background/session-normalization.js` only for reviewed-result metadata
- `test/agent.test.mjs`
- `test/agent-integration.test.mjs`
- `test/edit-preview.test.mjs`
- `test/project-tree.test.mjs`
- `test/workspace.test.mjs`
- `test/main-world-recovery.test.mjs`
- `test/protocol.test.mjs`
- `test/bridge-protocol.test.mjs`
- `test/document-snapshots.test.mjs`
- `test/edit-revert.test.mjs`
- `test/browser/smoke.test.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Direct filesystem access or a new multi-file product feature.
- Weakening exact active-file/editor-token checks.
- Removing auto approval; only represent it honestly.
- Guessing Typst folder/file type from an unrecognized icon.
- General main-world or workspace decomposition.

## Git workflow

- Branch: `codex/017-exact-tool-semantics`
- Suggested commits:
  - `test: characterize file-dependent tool batches`
  - `fix: preserve tool dependency order`
  - `fix: make edit and tree receipts exact`
- Do not push or merge into the user's branch.

## Steps

### Step 1: Add exact regression cases

Add tests for:

- `open A → read → open B → read` and the same shape with edits;
- an open/read pair separated by diagnostics and external/custom tools;
- a contiguous batch of `replace_lines` that still needs bottom-to-top order;
- unknown tree rows with and without collapsed/truncated entries;
- deletion of first, middle, final, multiple, only, and trailing-empty lines;
- Ask-approved versus Auto-applied `reviewed_diff` receipts;
- stale file/editor token checks remain fail-closed in both modes.

Assert exact file targets and final text, not only call order/count.

**Verify**: focused tests demonstrate each current semantic mismatch.

### Step 2: Build a dependency-preserving execution planner

Extract tool-order logic to `tool-execution-plan.js` as a pure function.
Preserve original provider order across stateful/dependent barriers, including:

- `open_project_file`;
- every document read/edit;
- custom and MCP side effects;
- diagnostics and other live-context reads.

Only reorder a proven-safe contiguous group: `replace_lines` calls against the
same active file/base snapshot may run bottom-to-top. Do not lift calls across
an open/read/side-effect barrier merely for diagnostics-last optimization.

If a batch is semantically ambiguous and cannot safely preserve intent, return
a structured result telling the model to issue the dependent call in the next
round; never silently retarget. Keep result emission/conversation order keyed
to original call IDs.

**Verify**: pure planner tests cover the complete barrier matrix and agent
integration tests observe exact active files.

### Step 3: Make project-tree completeness conservative

Treat any normalized `kind: 'unknown'` entry as evidence that the rendered
tree is incomplete. Return a bounded `unknown_entries` path list and a note
that the user may need to expand/identify those rows. Set `complete` only when:

- not truncated;
- no collapsed folders;
- no unknown entries.

Preserve unknown entries rather than coercing them to files or folders. Add a
workspace fixture with an altered SVG glyph and a no-extension unknown row.

**Verify**: project-tree and agent integration tests return `complete: false`
and exact unknown paths for icon drift.

### Step 4: Implement true line-range deletion

For empty `new_content`, consume the following newline when present; for a
final line without a following newline, consume the preceding newline. Define
the only-line and trailing-empty-line cases explicitly so no index becomes
negative or exceeds document length. Preserve current insertion verbatim for
non-empty replacement and keep CRLF handling consistent with normalized editor
text expectations.

**Verify**: the focused edit test applies each returned change and compares
the complete resulting document string.

### Step 5: Represent human review explicitly

Add an exact boolean/mode to the prepared-edit apply request indicating whether
the Ask flow actually displayed and received approval for the diff. The
main-world result must set `reviewed_diff` from that trusted worker-provided
mode, not always true. Auto mode should report `reviewed_diff: false` while
retaining exact snapshot/token/file validation and checkpoint creation.
Snapshot restore and checkpoint revert must send the same required field, but
remain conservatively `false`: neither apply producer carries a token proving
that this exact prepared diff was displayed and approved, and snapshot restore
can intentionally proceed after an explicit unavailable-diff warning.

Update persisted tool-result normalization and UI labels only where they
currently expose this field. Do not let page content choose the review mode.

**Verify**: Ask/Auto integration and main-world tests prove the receipt while
all stale-edit guards remain identical.

### Step 6: Document and run end-to-end editing QA

Update architecture/testing docs with tool-batch barriers, conservative tree
completeness, deletion boundaries, and reviewed-receipt semantics. Extend the
packaged smoke with at least one auto edit and one empty-line deletion if the
fixture supports it.

**Verify**: full verification, browser smoke, import checks, and diff hygiene
all pass.

## Test plan

- Pure execution-planner barrier matrix.
- Two-file read/edit integration with exact target assertions.
- Unknown/collapsed/truncated tree completeness combinations.
- Every empty deletion document boundary.
- Ask/Auto/stale edit receipt behavior through worker and main-world bridge.
- Existing hostile/provider tool ordering remains stable.

## Done criteria

- [ ] No tool call is moved across a file/state/side-effect dependency barrier.
- [ ] Safe contiguous line edits retain bottom-to-top ordering.
- [ ] Unknown tree entries force `complete: false` and are explained.
- [ ] Empty `replace_lines` removes the requested physical lines exactly.
- [ ] `reviewed_diff` is true only after explicit diff approval.
- [ ] Exact editor token, expected text, and active file checks remain intact.
- [ ] Tool planning has a focused module and `agent.js` retains orchestration.
- [ ] Focused/full tests, browser smoke, import checks, and diff hygiene pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Existing provider behavior depends on global reordering across a stateful
  file boundary.
- Multiple `replace_lines` calls are resolved against different base snapshots
  and cannot be safely reordered as a contiguous group.
- Typst editor text preserves newline conventions that contradict the tested
  deletion policy.
- The review-mode bit would be controllable by the page or model rather than
  the trusted worker approval state.

## Maintenance notes

- New tools must declare whether they are ordering barriers before planner
  optimization is allowed.
- Unknown DOM structure should degrade capability claims, never confidence.
- Product direction for direct multi-file access depends on these exact
  ordering and tree semantics.
