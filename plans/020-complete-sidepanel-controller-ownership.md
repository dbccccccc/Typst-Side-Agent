# Plan 020: Complete side-panel controller ownership and shrink `app.js`

> **Executor instructions**: This is a behavior-preserving structural plan
> after the correctness/performance plans. Add characterization tests before
> moving code. Follow every gate and touch only in-scope files. The reviewer
> maintains `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/sidepanel/app.js src/sidepanel/session-controller.js src/sidepanel/run-ui-controller.js src/sidepanel/transition-coordinator.js src/sidepanel/snapshot-controller.js test/sidepanel-controllers.test.mjs ARCHITECTURE.md`
> The executor is expected to run this on the cumulative branch after plans
> 014, 015, 018, and 019. Reconcile excerpts to that live state. Changed
> controller ownership or lifecycle semantics without matching tests is a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 014, 015, 018, and 019
- **Category**: tech-debt, tests
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

`ARCHITECTURE.md` says `app.js` performs panel-level composition and
`session-controller.js` owns navigation/captured saves. In reality the
1,208-line app still implements session load/switch/rename/delete/reconcile,
run cancellation before navigation, the send lifecycle, tab synchronization,
and active-run recovery. The advertised controller is a 27-line RPC facade.
This plan makes ownership real, improves direct state-machine coverage, and
leaves `app.js` as wiring/orchestration rather than another mutable god module.

## Current state

- `src/sidepanel/session-controller.js:7-27` forwards storage requests and
  shallowly assigns active session/history.
- `src/sidepanel/app.js:263-489` owns all session lifecycle transitions,
  stale-epoch checks, persistence, deletion fallback, and cancel-before-switch.
- `src/sidepanel/app.js:670-805` owns send preparation/start state; plan 014
  adds reservation and sticky cancellation that must be moved intact.
- `src/sidepanel/app.js:810-909` owns terminal/reconnected-run settlement and
  auto naming.
- `src/sidepanel/app.js:213-257` owns tab/project synchronization and resets
  snapshot/revert/attachment state.
- Existing controller tests use dependency injection and plain state objects.
  Keep this testable native-ESM style; do not introduce a UI framework.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/sidepanel-controllers.test.mjs test/session-import.test.mjs test/chat-checkpoint.test.mjs test/composer-shortcut.test.mjs` | all pass |
| Static ownership | `node --test test/static.test.mjs` | all pass, app ownership assertions succeed |
| Full verification | `npm run verify` | exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 |
| Import boundaries | `npm run check:imports` | no cycles/layer violations |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/sidepanel/app.js`
- `src/sidepanel/session-controller.js`
- `src/sidepanel/send-controller.js` (create)
- `src/sidepanel/tab-controller.js` (create)
- `src/sidepanel/run-ui-controller.js`
- `src/sidepanel/transition-coordinator.js`
- `src/sidepanel/state.js`
- `src/sidepanel/snapshot-controller.js` only for injected reset/scope hooks
- `src/sidepanel/attachment-controller.js` only for injected clear/refresh hooks
- `src/sidepanel/chat.js` only for explicit controller-facing render callbacks
- `test/sidepanel-controllers.test.mjs`
- `test/static.test.mjs`
- `test/browser/smoke.test.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Visual redesign, CSS changes, or new user-facing features.
- Moving low-level DOM constructors into generic utilities.
- Changing storage/protocol/provider semantics established by plans 014–019.
- Refactoring settings registry/forms or content-script modules.
- A framework, TypeScript, or bundler migration.

## Git workflow

- Branch: `codex/020-sidepanel-controllers`
- Use small commits:
  - `test: characterize sidepanel transitions`
  - `refactor: move session lifecycle to controller`
  - `refactor: extract send and tab controllers`
- Do not push or merge into the user's branch.

## Target ownership

- `app.js`: instantiate controllers, provide concrete DOM/Chrome callbacks,
  wire events, and call `init()`.
- `session-controller.js`: load/create/activate/switch/rename/delete/reconcile,
  captured revision-aware saves, cancellation-before-navigation coordination,
  and stale session epochs.
- `send-controller.js`: prepare/reserve/start/cancel/settle one send using plan
  014's state machine; no session navigation or DOM construction.
- `tab-controller.js`: query active tab, derive project identity, own tab sync
  epochs, and coordinate project-change resets/load.
- `run-ui-controller.js`: immutable active-run correlation and exact terminal
  settlement only.
- Feature views (`chat`, snapshots, attachments): own their DOM and expose
  narrow callbacks; controllers do not query arbitrary selectors.

## Steps

### Step 1: Characterize complete lifecycle behavior

Before extraction, add direct tests for:

- initial project with no sessions creates and activates one;
- stale tab sync and stale session switch cannot commit UI state;
- switch during an active run cancels/settles exactly once before saving;
- save failure prevents navigation and preserves the active session/history;
- rename current/noncurrent session and auto-name/manual-name interaction;
- delete active/nonactive/last session fallback;
- management-pane mutation reconciliation;
- plan 014 early cancellation/reservation and terminal reconnect behavior;
- project change resets snapshot/revert/attachments in the right order.

Use injected request, view, clock, and Chrome-tab adapters. Assert state and
callback order, not implementation-private function names.

**Verify**: controller-focused tests cover actual navigation/send transitions,
not only RPC message types.

### Step 2: Expand the session controller around one transition API

Move session lifecycle from `app.js` behind methods such as `loadProject`,
`switchTo`, `createAndSwitch`, `rename`, `remove`, `reconcile`, and
`saveCaptured`. Inject:

- request/storage facade;
- current state access;
- transition epoch coordinator;
- active-run cancellation hook;
- view callbacks for list/name/messages/status;
- snapshot/revert reset hooks.

Every async method must capture project/session/history/revision identity and
revalidate it after awaits. Do not let the controller own raw document lookup
or HTML construction.

**Verify**: session lifecycle tests pass with no import of `app.js`.

### Step 3: Extract send orchestration without weakening plan 014

Move send preparation/reservation/persistence/start/cancellation and terminal
settlement into `send-controller.js`. Inject model lookup, tab/file lookup,
attachments, session persistence, run UI, stream view, status, and protocol
request functions.

Retain plan 014's sticky token and reservation/tombstone invariants. The
controller returns explicit outcomes (`started`, `cancelled`, `rejected`,
`failed`) so `app.js` only updates surrounding view state through injected
callbacks. Auto naming may be an injected post-start task but must remain bound
to captured session identity.

**Verify**: all pre-start cancellation, failure, terminal, and reconnect cases
pass as direct controller tests.

### Step 4: Extract tab/project synchronization

Move active-tab query, project-ID derivation, tab epoch handling, and project
change coordination into `tab-controller.js`. Inject UI gating and feature
reset/load hooks. A stale query must never reset current state or load sessions.

Keep the Typst URL parser pure and directly tested. Do not duplicate project
identity parsing used by the protocol/background; share a pure side-panel-safe
helper only if layer rules allow it.

**Verify**: rapid tab A→B→A and leaving/re-entering Typst tests commit only the
latest identity.

### Step 5: Reduce `app.js` to composition and event wiring

Replace inline lifecycle functions with controller calls. `app.js` may retain:

- concrete element lookup and view callback assembly;
- controller instantiation;
- runtime/UI event wiring;
- bootstrap/init ordering;
- small panel-wide coordination that belongs to no feature.

Remove old inline copies after each focused suite passes. Add static ownership
assertions that `app.js` no longer defines `switchSession`, `handleSend`,
`cancelActiveRunBeforeNavigation`, or session CRUD flows. The target is fewer
than 700 lines, but reviewers must prioritize coherent ownership over padding
or compressed unreadable code.

**Verify**: line/ownership static checks, focused tests, and import checks pass.

### Step 6: Update architecture and packaged QA

Update `ARCHITECTURE.md` to match actual controller ownership and add a short
dependency diagram or table. Update `TESTING.md` with the controller suites.
Run packaged smoke across create/switch/send/cancel/reconnect/delete flows.

**Verify**: full verification, browser smoke, import checks, and diff hygiene
all pass.

## Test plan

- Session load/switch/save/rename/delete/reconcile success and failure matrix.
- Stale tab/session epochs and rapid navigation.
- Active/preparing run cancellation during navigation.
- Revision conflict handling from plan 016.
- Send reservation/start/terminal/reconnect behavior from plan 014.
- Browser smoke covering one complete multi-session lifecycle.

## Done criteria

- [ ] Documented session, send, tab, and run UI owners match live code.
- [ ] `app.js` contains composition/event wiring, not domain lifecycle
      implementations, and is below 700 readable lines.
- [ ] Session navigation and send state machines have direct injected tests.
- [ ] No lifecycle implementation is duplicated between app and controllers.
- [ ] Stale identity, cancellation, revision, snapshot, and attachment invariants
      from prior plans remain tested.
- [ ] No new import cycles or sidepanel-to-background/content layer crossing.
- [ ] Focused/full tests, browser smoke, import checks, and diff hygiene pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Extraction requires changing a prior plan's user-visible behavior rather than
  moving it behind an interface.
- A controller needs unrestricted document access instead of narrow view hooks.
- Circular ownership appears between session, send, and run UI controllers.
- The line target can be met only through minification, compressed formatting,
  or a generic junk-drawer module.

## Maintenance notes

- New side-panel workflows should enter through one owning controller and one
  injected view interface.
- Review controller tests for meaningful transition assertions; forwarding-only
  tests do not justify extraction.
- Keep `app.js` readable composition code rather than treating zero lines as the
  goal.
