# Plan 016: Make session and recovery storage conflict-safe

> **Executor instructions**: Follow the steps and verification gates exactly.
> This is crash-consistency work: do not reorder durable writes without a test
> that injects failure at each phase. Touch only in-scope files. The reviewer
> maintains `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/background/storage.js src/background/session-normalization.js src/background/agent.js src/sidepanel/session-controller.js src/sidepanel/app.js src/shared/protocol.js test/storage.test.mjs`
> The plan targets the audited live worktree. Compare all current-state excerpts
> below; a changed session schema, checkpoint state machine, or cleanup order is
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 014
- **Category**: bug, tech-debt
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

Generic tool results are summarized twice per save and recursively JSON-encode
on every later save. Session message updates replace a full caller snapshot,
so stale writers have no conflict signal. Recovery retention and chat deletion
also remove old checkpoints/snapshots before the replacement or owning deletion
is durably committed. Together these paths can corrupt readable history or
erase valid recovery points after an operation reports failure.

## Current state

- `src/background/session-normalization.js:95-98` normalizes every message and
  then calls `minimizeMessage()`; tool results were already summarized at
  `161-178`, and `226-235` summarizes them again.
- `src/background/storage.js:514-544` serializes `sessionUpdate()` but replaces
  `messages` with the caller's complete array and has no expected revision.
- `src/background/agent.js:208-223` performs a separate session read, chooses a
  whole array by length, appends, then calls `sessionUpdate()`.
- `src/background/storage.js:808-847` publishes a pruned checkpoint index and
  deletes victim bodies before the incoming checkpoint body/index is written.
- `src/background/storage.js:548-610` removes checkpoints and automatic
  snapshots before publishing single-session or project deletion.
- `ARCHITECTURE.md:264-269` states the intended invariant: create/update writes
  the new body before publishing its pointer, while deletes publish metadata
  removal before deleting bodies. The live recovery paths must match it.
- Storage uses one module-level serialized mutation queue. Preserve one
  coordinator; plan 021 will decompose repositories after these invariants are
  characterized.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/storage.test.mjs test/agent-integration.test.mjs test/sidepanel-controllers.test.mjs test/protocol.test.mjs` | all pass |
| Full verification | `npm run verify` | exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 |
| Import boundaries | `npm run check:imports` | no cycles/layer violations |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/background/session-normalization.js`
- `src/background/storage.js`
- `src/background/agent.js` only for the transcript persistence adapter call
- `src/background/service-worker.js`
- `src/shared/protocol.js`
- `src/shared/constants.js`
- `src/sidepanel/session-controller.js`
- `src/sidepanel/app.js` only for expected-revision handling/reconciliation
- `src/sidepanel/chat.js` only for revision-aware revert-receipt persistence
- `test/storage.test.mjs`
- `test/agent-integration.test.mjs`
- `test/protocol.test.mjs`
- `test/sidepanel-controllers.test.mjs`
- `test/chat-checkpoint.test.mjs`
- `test/helpers/fakes.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Splitting `storage.js`; plan 021 owns that mechanical refactor.
- Changing export format without backward-compatible schema handling.
- Increasing storage quotas or silently discarding user-authored messages.
- Persisting credentials, run payloads, or unbounded idempotency logs.
- Recovering a corrupted index by guessing from arbitrary bodies.

## Git workflow

- Branch: `codex/016-conflict-safe-storage`
- Suggested commits:
  - `test: characterize storage conflict and crash phases`
  - `fix: make session history normalization idempotent`
  - `fix: publish recovery mutations before cleanup`
- Do not push or merge into the user's branch.

## Steps

### Step 1: Build deterministic failure-injection coverage

Extend `FakeStorage` with named or counted failure hooks that can reject a
specific body write, index publication, cleanup removal, or startup repair.
Add tests proving the required post-failure state for:

- repeated session save/load normalization;
- two stale message writers against one session;
- agent assistant append racing a name-only update;
- checkpoint retention at count and byte boundaries;
- failure while staging the replacement body;
- failure while publishing the replacement index;
- single-chat and project deletion failures at every index/cleanup phase;
- restart after a committed deletion but interrupted recovery cleanup.

For every phase, assert both metadata and referenced body readability. Do not
assert only operation return values.

**Verify**: focused storage tests fail for the documented current ordering and
print the failed phase name.

### Step 2: Make message normalization byte-idempotent

Ensure a tool result is summarized exactly once. Choose one owner:

- normalize tool segments directly into final persisted summaries and make
  minimization a no-op for those results; or
- separate structural validation from one explicit minimization pass.

Do not infer that any arbitrary `{ok, summary}` object is already trusted; use
an internal normalization path or strict shape validator. Preserve specialized
read/edit/diagnostics summaries, size caps, imported-message restrictions, and
display compatibility.

Add tests asserting one, two, and five calls to `minimizeMessagesForStorage()`
produce byte-identical JSON for built-in, custom, MCP, error, truncated, and
malformed result shapes.

**Verify**: `node --test test/storage.test.mjs` passes idempotence cases and the
stored generic summary contains one JSON encoding layer.

### Step 3: Add revision-aware replace and atomic append APIs

Give materialized sessions an opaque monotonically increasing `revision` that
defaults safely for existing schema-v2 metadata and increments only when the
session body changes. Exact-message replacement must accept an expected
revision and fail with stable `SESSION_CONFLICT` before writing when stale.
Name-only/auto-name updates may merge against the current body without a stale
message replacement.

Add a worker-owned atomic assistant-append operation that executes entirely
inside the storage mutation queue:

1. load the current metadata/body;
2. compare the exact last assistant result fingerprint for idempotent retry;
3. append or update response status;
4. write a new versioned body;
5. publish its metadata pointer;
6. clean the prior body best-effort.

Replace the read/length/replace sequence in `agent.js` with this API. The
side-panel controller must pass the captured revision for full-history saves,
handle `SESSION_CONFLICT` by reloading authoritative state, and never silently
overwrite it. The revert-receipt path in `chat.js` must participate in the same
revision contract or use a narrowly scoped worker-owned receipt merge; it must
not retain a revisionless full-history replacement exception. Preserve plan
014's session reservation as the immediate UX lock.

**Verify**: concurrent/stale tests show no lost user or assistant turn and
name-only updates preserve messages.

### Step 4: Stage checkpoint replacements before pruning victims

Change checkpoint retention to compute a pure prune plan first. Then:

1. validate and write the incoming body while all old references remain;
2. publish one index containing the new checkpoint and excluding victims;
3. only after successful publication, delete victim bodies best-effort.

A temporary logical-budget overage during the body-before-index window is
acceptable; if Chrome quota prevents staging, fail cleanly and preserve all old
checkpoints. Do not pre-delete a valid victim to force a new write through.
Startup orphan cleanup must remove an incoming body left by failed publication.

Apply the same publish-before-cleanup rule to any snapshot path that still
deletes victims first after inspection.

**Verify**: every staged-body/index failure leaves prior checkpoints readable;
successful replacement ends within configured count/byte limits.

### Step 5: Commit chat deletion before recovery cleanup

For session/project deletion:

1. publish the session index without the deleted record(s);
2. then remove session bodies, edit checkpoints, and automatic snapshots;
3. make cleanup idempotent and best-effort after ownership is committed;
4. on startup, remove recovery records whose session no longer exists.

If cleanup needs a durable marker, keep it bounded and schema-versioned. Do not
make a failed cleanup resurrect a deleted chat, and do not delete manual/rescue
snapshots merely because an automatic chat was deleted.

**Verify**: failure before session-index publication preserves chat and all
recovery data; failure after publication leaves the chat deleted and restart
finishes cleanup safely.

### Step 6: Document and run the complete storage matrix

Update architecture/storage documentation for revisions, atomic append,
publish-before-cleanup, and restart repair. Run focused tests, full verification,
browser smoke, audit, and diff hygiene.

**Verify**: `npm run verify`, `npm run test:browser`, `npm audit`, and
`git diff --check` all succeed.

## Test plan

- Byte-stable normalization through repeated saves.
- Revision conflict, successful retry/reload, atomic assistant append, and
  name-only merge.
- Failure injection before/after every body/index publication.
- Retention under count/byte caps and real quota failure.
- Delete single session/project with interrupted recovery cleanup and restart.
- Existing v2 metadata without a revision remains readable and upgrades on the
  next body mutation.

## Done criteria

- [ ] Repeated normalization is byte-idempotent.
- [ ] Stale full-history saves fail explicitly and cannot overwrite current
      messages.
- [ ] Agent transcript append is one queued storage transaction.
- [ ] Replacement staging never destroys prior checkpoints on failure.
- [ ] Session deletion publishes ownership before deleting recovery data.
- [ ] Interrupted post-delete cleanup completes safely on restart.
- [ ] Existing v1/v2 imports and stored v2 sessions remain readable.
- [ ] Storage budgets, data minimization, and export exclusions remain intact.
- [ ] Focused/full tests, browser smoke, import checks, audit, and diff hygiene
      pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Backward compatibility requires an irreversible migration with no resumable
  marker or failure-injection test.
- Chrome quota makes replacement impossible without deleting the only valid
  recovery point first.
- Conflict handling would silently choose one user's history rather than
  returning authoritative state.
- A proposed cleanup ordering can leave metadata pointing at a deleted body.

## Maintenance notes

- Future body-changing APIs must participate in session revision checks or the
  atomic append path.
- Keep cleanup idempotent; MV3 workers may terminate between any two awaits.
- Plan 021 may move these functions, but it must preserve the exact tests and
  one shared transaction coordinator established here.
