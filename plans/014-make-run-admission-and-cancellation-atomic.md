# Plan 014: Make run admission and cancellation atomic

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. If a STOP condition occurs, stop and report
> rather than improvising. The reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/shared/protocol.js src/background/agent.js src/background/service-worker.js src/sidepanel/app.js src/sidepanel/run-ui-controller.js src/sidepanel/transition-coordinator.js test`
> This plan intentionally targets the audited live worktree, which already
> differs substantially from commit `5bf9eed`. Compare the excerpts below with
> live code. A semantic mismatch in run start, cancel, or transition ownership
> is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 003, 006, 009, and 012 (all DONE)
- **Category**: bug, tech-debt
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

The side panel exposes Stop before the background worker has accepted a run.
If Stop or navigation occurs while the initial session save is pending, the
worker reports the run as unknown and the panel later dispatches it anyway.
Two panels can also prepare the same chat concurrently because admission is
currently keyed only by run ID. This plan creates an explicit, bounded
reservation/admission state so cancellation is sticky and only one panel may
mutate a session for a new run at a time.

## Current state

- `src/sidepanel/app.js:731-785` calls `runUiController.begin()`, marks the UI
  streaming, awaits `saveSessionSnapshot()`, and then dispatches
  `AI_STREAM_START` without rechecking cancellation.
- `src/sidepanel/app.js:670-675` handles Stop by sending only
  `AI_STREAM_CANCEL`; no local cancellation flag is recorded.
- `src/background/agent.js:921-948` rejects only an already-active `runId` and
  registers no session-level admission lock.
- `src/background/agent.js:1148-1153` returns `found: false` when cancellation
  arrives before registration and keeps no tombstone.
- `src/sidepanel/transition-coordinator.js` already owns single-flight send
  tokens and stale transition epochs. Extend this explicit state-machine
  pattern instead of adding unrelated globals.
- `src/sidepanel/run-ui-controller.js` owns immutable UI run identity and exact
  terminal settlement. Preserve that ownership.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/sidepanel-controllers.test.mjs test/agent-integration.test.mjs test/protocol.test.mjs` | all pass |
| Full verification | `npm run verify` | exit 0; all tests and coverage floors pass |
| Browser smoke | `npm run test:browser` | exit 0 |
| Import boundaries | `npm run check:imports` | no cycles or layer violations |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/shared/protocol.js`
- `src/background/agent.js`
- `src/background/service-worker.js`
- `src/background/run-coordinator.js` (create if a focused coordinator is the
  cleanest ownership boundary)
- `src/sidepanel/app.js`
- `src/sidepanel/run-ui-controller.js`
- `src/sidepanel/transition-coordinator.js`
- `test/protocol.test.mjs`
- `test/agent-integration.test.mjs`
- `test/sidepanel-controllers.test.mjs`
- `test/browser/smoke.test.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Session-body CAS/append semantics; plan 016 owns durable storage conflicts.
- Provider, MCP, or editor-approval behavior.
- A global cancel-all command.
- Detaching a run so it may continue after explicit user cancellation.
- Any framework, bundler, or TypeScript migration.

## Git workflow

- Branch: `codex/014-atomic-run-admission`
- Commits: `test: characterize pre-start cancellation`, then
  `fix: make run admission and cancellation atomic`.
- Do not push or merge into the user's branch.

## Steps

### Step 1: Characterize the two race windows

Add deterministic deferred-promise tests for:

1. Stop while `saveSessionSnapshot()` is pending; no start may reach the agent.
2. Session navigation during that same wait; no start may occur afterward.
3. Cancel arriving at the worker before start; a later start with that run ID
   must finish as cancelled without provider discovery or side effects.
4. Two panels reserving different run IDs for one session; exactly one is
   accepted and the loser does not append or persist its user turn.
5. Different sessions and different projects remain independently admissible.

Use the injected-controller style in `test/sidepanel-controllers.test.mjs` and
the deferred fakes in `test/helpers/fakes.mjs`. Avoid real timers.

**Verify**: the focused command loads all new tests and the race assertions
fail before the implementation rather than hanging.

### Step 2: Add a bounded run-reservation protocol

Add an exact protocol request/response for reserving a run identity before the
panel mutates visible history. The request must contain the existing immutable
tuple `runId + tabId + projectId + sessionId`. Validation must reject malformed
or extra fields in the same fail-closed style as other protocol messages.

The background coordinator must:

- reserve by both `runId` and `sessionId`;
- reject a duplicate active/reserved session with stable code
  `SESSION_RUN_ACTIVE`;
- expire abandoned reservations after a short bounded TTL;
- cap reservation/tombstone counts and prune oldest expired records;
- never block an unrelated session;
- allow `AI_STREAM_START` only when it consumes the exact reservation;
- release the reservation on failed preparation, cancellation, or completion.

Keep the coordinator pure apart from injected clock/timer dependencies so Node
tests can exercise TTL behavior deterministically.

**Verify**: `node --test test/protocol.test.mjs test/agent-integration.test.mjs`
passes reservation identity, duplicate-session, expiry, and cleanup cases.

### Step 3: Make panel cancellation sticky

Extend the transition/send token with explicit phases such as `preparing`,
`reserved`, `starting`, `active`, and terminal `cancelled`. Provide methods that
cancel the exact token and answer whether dispatch is still allowed. Do not
mutate a frozen token through hidden side channels; keep mutable state owned by
the coordinator.

In `handleSend()`:

1. Prepare the tab/file/attachments.
2. Reserve the run before calling `runUiController.begin()`, pushing the user
   message, clearing the composer, or saving the session.
3. Recheck the token after every await, especially after reservation and
   session persistence.
4. If cancelled, release/cancel the reservation, remove the empty streaming
   placeholder, preserve the user's composer text if it was not committed, and
   never dispatch `AI_STREAM_START`.
5. If persistence fails, release the reservation and settle the UI exactly
   once.

Repeated Stop clicks must be idempotent. Navigation cancellation must share the
same state-machine path rather than having a second race-prone implementation.

**Verify**: controller tests prove no start after Stop/navigation at every
deferred boundary.

### Step 4: Retain bounded cancellation tombstones

When a valid cancellation names a reserved or not-yet-active run, retain a
short-lived tombstone. Run admission/start must consult it before discovery,
network activity, or page requests and settle as cancelled. Remove the
tombstone once consumed or expired.

Do not retain arbitrary payloads, session history, or user text in the
tombstone. Bound memory and expose counts only through test adapters, not a new
public debug protocol.

**Verify**: a cancel-before-start integration test records zero provider,
custom-tool, MCP, and page dispatches and exactly one terminal cancellation.

### Step 5: Document and smoke-test the lifecycle

Update `ARCHITECTURE.md` with the reservation-to-active transition and
`TESTING.md` with pre-start Stop plus two-panel/same-session QA. Extend the
packaged smoke with a delayed initial session save or equivalent deterministic
hook, then assert Stop prevents model traffic.

**Verify**: `npm run verify`, `npm run test:browser`, and `git diff --check`
all pass.

## Test plan

- Exact reservation envelope success/failure and unknown-field rejection.
- Cancel at each pre-dispatch await boundary.
- Reservation cleanup on persistence error and abandoned TTL.
- Two same-session panels versus two unrelated sessions.
- Duplicate Stop and terminal-event idempotence.
- Browser smoke assertion that no provider request occurs after early Stop.

## Done criteria

- [ ] A panel reserves before mutating/persisting a new run turn.
- [ ] Only one reserved/active run may own a session.
- [ ] Stop/navigation is sticky across every pre-start await.
- [ ] Cancel-before-start prevents discovery, network, page, and tool effects.
- [ ] Reservations and tombstones are time/count bounded and tested.
- [ ] Every failure releases ownership and settles the UI exactly once.
- [ ] Different sessions can still run independently.
- [ ] Focused tests, full verification, browser smoke, import checks, and diff
      hygiene pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Chrome message routing cannot provide an acknowledgement before UI mutation
  without changing terminal stream-event semantics.
- A reliable same-session identity is unavailable at reservation time.
- The existing protocol cannot add one validated request without weakening its
  exact-envelope policy.
- The implementation would globally serialize unrelated sessions.
- Correctness requires changing session storage format; defer that part to
  plan 016 rather than improvising here.

## Maintenance notes

- Any future pre-run asynchronous preparation must recheck the same token.
- Reviewers should count provider/page/tool calls, not only inspect UI status.
- Plan 016 adds durable conflict-safe session writes; retain this admission
  layer because storage CAS alone cannot communicate immediate UX ownership.
