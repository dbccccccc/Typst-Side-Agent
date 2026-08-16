# Plan 021: Split storage repositories behind one transaction coordinator

> **Executor instructions**: This is a behavior-preserving extraction after
> plan 016 establishes the final storage invariants. Move one domain at a time,
> run its focused tests, and delete the old copy before continuing. Touch only
> in-scope files. The reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- src/background/storage.js src/background/session-normalization.js src/shared/constants.js test/storage.test.mjs scripts/check-imports.mjs ARCHITECTURE.md`
> Execute on the cumulative branch after plan 016. Reconcile the current
> revision/CAS, append, publish-before-cleanup, and startup-repair code before
> extraction. Any mismatch in those invariants is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 016
- **Category**: tech-debt, tests
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

`src/background/storage.js` is 1,437 lines with 37 exports and owns settings,
session migration/bodies, edit checkpoints, document snapshots, tool/MCP
registries, theme, and access restriction. The shared adapter and mutation
queue hide which operations are domain-local and which require cross-domain
ordering. This plan creates explicit repositories while preserving exactly one
transaction coordinator for session deletion, recovery cleanup, migrations,
and all other multi-key invariants.

## Current state

- `src/background/storage.js:23-69` owns one module-global adapter, migration
  promise, and serialized `mutationQueue`.
- Settings occupy roughly lines 72–163; session repository/migration lines
  165–702; checkpoints 704–1044; snapshots 1046–1294; custom/MCP/theme/access
  1296–1381; shared helpers/errors follow.
- `sessionDelete()` and `sessionDeleteByProject()` cross session, checkpoint,
  and automatic-snapshot domains. Plan 016 makes them publish session ownership
  before idempotent recovery cleanup; that coordination must not be split into
  independent queues.
- Tests import the stable public surface from `src/background/storage.js`.
  Preserve that facade so service-worker and agent callers do not need a broad
  migration.
- `scripts/check-imports.mjs` already rejects cycles and layer crossings. New
  background submodules must remain inside the background layer and acyclic.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Storage tests | `node --test test/storage*.test.mjs` | all storage domain and failure-injection tests pass |
| Integration tests | `node --test test/agent-integration.test.mjs test/document-snapshots.test.mjs test/edit-revert.test.mjs` | all pass |
| Full verification | `npm run verify` | exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 |
| Import boundaries | `npm run check:imports` | no cycles/layer violations |
| Public API search | `rg -n "from '../src/background/storage.js'|from './storage.js'" test src/background` | callers continue using facade |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/background/storage.js`
- `src/background/storage/core.js` (create)
- `src/background/storage/settings-repository.js` (create)
- `src/background/storage/session-repository.js` (create)
- `src/background/storage/checkpoint-repository.js` (create)
- `src/background/storage/snapshot-repository.js` (create)
- `src/background/storage/registry-repository.js` (create)
- `src/background/storage/repository-coordinator.js` (create)
- `src/background/session-normalization.js` only if an import seam must move
- `src/shared/constants.js` only for existing domain keys/limits comments
- `test/storage.test.mjs`
- `test/storage-settings.test.mjs` (create if splitting tests clarifies domains)
- `test/storage-sessions.test.mjs` (create)
- `test/storage-recovery.test.mjs` (create)
- `test/helpers/fakes.mjs`
- `scripts/check-imports.mjs`
- `ARCHITECTURE.md` and `TESTING.md`

**Out of scope**:

- Any storage schema, quota, retention, export, or user-visible behavior change.
- Independent per-domain mutation queues.
- Replacing `chrome.storage.local` or adding a database dependency.
- Renaming public service-worker protocol messages.
- Moving endpoint/trust validation into storage core.
- General agent or side-panel refactors.

## Git workflow

- Branch: `codex/021-storage-repositories`
- Commit after each passing extraction:
  - `refactor: extract storage core and settings`
  - `refactor: extract session repository`
  - `refactor: extract recovery repositories`
  - `refactor: add storage transaction coordinator`
- Do not push or merge into the user's branch.

## Target architecture

Create one repository context at facade initialization containing:

- the current storage adapter;
- one serialized mutation queue;
- injected clock/ID helpers where tests already override them;
- read/write/remove/list primitives;
- shared structured storage errors.

Domain modules receive that context; they must not create their own adapter or
queue. `repository-coordinator.js` owns cross-domain operations and startup
repair. `storage.js` remains a narrow facade that configures/resets the context
and re-exports/delegates the existing public API.

## Steps

### Step 1: Lock the public API and cross-domain invariants

Add a static/public-contract test enumerating every current storage export and
its basic arity/availability. Expand failure-injection tests from plan 016 so
they remain green after movement. Record domain ownership and the operations
that intentionally coordinate across repositories.

**Verify**: current monolith passes the new public-contract and invariant tests
before extraction.

### Step 2: Extract one shared storage context

Move adapter access, read/write/remove/list primitives, queue ownership,
byte/error helpers, and reset/configuration into `storage/core.js`. Prefer a
factory/context object over mutable exports spread across modules. Reset must
replace or reset one context consistently for every repository in tests.

Do not export raw write/remove primitives from the public `storage.js` facade.
Only domain repositories and coordinator receive them.

**Verify**: settings and existing storage tests pass; a test proves concurrent
mutations from different repositories still serialize through one queue.

### Step 3: Extract settings and registry repositories

Move settings/model mutations to `settings-repository.js`. Move custom tools,
MCP servers, theme, and access restriction to `registry-repository.js` while
retaining endpoint/header validation in the same domain boundary or its current
shared validators.

Keep settings/registry worker-authoritative merge behavior from existing
concurrency tests. Do not create a generic records utility unless at least two
repositories share an identical, tested invariant.

**Verify**: focused settings/registry tests, lint, and import checks pass before
removing old implementations.

### Step 4: Extract the session repository

Move session index/body schema validation, migration, revision-aware updates,
atomic append, list/import/export/status, and orphan body cleanup to
`session-repository.js`. Keep session normalization imported from the existing
focused module.

Expose internal coordinator hooks only for:

- publishing session deletion;
- enumerating authoritative surviving session IDs/project IDs;
- cleaning session bodies after publication.

Do not expose raw index/body mutation to unrelated callers.

**Verify**: all migration, CAS/append, import/export, quota, and session failure
tests pass with the monolith copy removed.

### Step 5: Extract checkpoint and snapshot repositories

Move each schema, validation, body/index access, retention planning, status
machine, load/list/delete, and orphan cleanup to its named module. Preserve plan
016's stage-before-prune and publish-before-cleanup ordering exactly.

Expose narrow coordinator hooks for deleting automatic recovery records by
session/project and startup repair against surviving sessions. Manual/rescue
snapshot behavior must remain separate and protected.

**Verify**: checkpoint cascade/revert, snapshot restore/list/delete, retention,
failure-injection, and startup repair tests pass after old code removal.

### Step 6: Centralize cross-domain coordination

Implement in `repository-coordinator.js`:

- single-session deletion;
- project deletion;
- startup cleanup of recovery records whose session no longer exists;
- any migration/startup sequence requiring multiple repositories.

The coordinator must call domain operations inside the one core mutation
transaction/queue and maintain the exact publication order from plan 016.
Domain repositories may not import one another; dependency direction is
facade/coordinator → repositories → core/shared.

Add import-checker assertions for that direction if the generic cycle checker
does not make violations obvious.

**Verify**: cross-domain failure tests and import checks pass.

### Step 7: Reduce the facade and split tests by ownership

Make `storage.js` a readable facade of roughly 150 lines or fewer containing
configuration plus stable delegates/exports. Keep each repository focused;
target under 500 lines where practical, but do not compress code or split a
single state machine artificially to hit a number.

Split the 700+ line storage test file into domain files if it improves fixture
clarity. Share `FakeStorage` and failure helpers through `test/helpers`, not
duplicated local fakes.

**Verify**: static ownership checks show no domain implementation remains in
the facade, and all storage tests run from `test/storage*.test.mjs`.

### Step 8: Document and run the full repository matrix

Update architecture docs with a dependency/transaction table and instructions
for adding a new storage domain safely. Run full verification, browser smoke,
audit, and diff hygiene.

**Verify**: every command in the table passes.

## Test plan

- Public export contract through `storage.js`.
- One queue serializes cross-domain concurrent mutations.
- Adapter configure/reset affects every repository.
- All session migrations/revisions/append/import/export cases.
- Checkpoint and snapshot retention/state/failure matrices.
- Session/project deletion and interrupted cleanup across repositories.
- Startup orphan recovery and unsupported/corrupt index behavior.
- Import graph has no repository cycles or direct cross-domain imports.

## Done criteria

- [ ] `storage.js` is a narrow stable facade, roughly ≤150 readable lines.
- [ ] Settings, sessions, checkpoints, snapshots, and registries each have a
      named repository with focused tests.
- [ ] Exactly one adapter context and mutation coordinator exist.
- [ ] Domain repositories do not import one another.
- [ ] Cross-domain delete/startup work goes through the coordinator in the
      tested publication order.
- [ ] No storage schema, retention, export, or visible behavior changed.
- [ ] Existing service-worker/agent callers continue importing `storage.js`.
- [ ] Focused/full tests, browser smoke, import checks, audit, and diff hygiene
      pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- Any repository extraction requires a second independent mutation queue.
- A domain cannot preserve plan 016's failure behavior through the proposed
  interface.
- A public caller depends on an untested private helper from the monolith.
- The facade target can be met only by wildcard re-export cycles or compressed
  unreadable code.
- Migration or recovery semantics change during what should be extraction.

## Maintenance notes

- Review cross-domain operations for publication ordering whenever a new
  repository is introduced.
- Keep storage tests phase-oriented; MV3 termination can occur between awaits.
- Prefer adding a narrow coordinator hook over importing a sibling repository.
