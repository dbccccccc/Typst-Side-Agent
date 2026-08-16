# Plan 009: Make session storage transactional, bounded, and minimal

> **Executor instructions**: Execute after plans 003 and 005. Migration must be
> resumable and preserve valid existing sessions. Do not delete the legacy
> record until every migrated session has been written and verified. Update
> plan 009 in <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/storage.js src/background/service-worker.js src/shared/constants.js src/sidepanel/app.js src/sidepanel/chat.js src/sidepanel/settings-panel.js README.md PRIVACY.md TESTING.md test</code>
> Changed run/session identity or imported-message schema is a STOP condition
> until reconciled.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**:
  <code>plans/003-isolate-agent-runs.md</code>,
  <code>plans/005-sanitize-chat-rendering.md</code>
- **Category**: bug, performance, security
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

All sessions currently live in one <code>chrome.storage.local</code> value.
Every create, save, rename, import, or delete performs an unversioned
load-modify-save of the entire array, so concurrent panels can overwrite one
another. Full preview PNG data URLs and raw document/MCP/custom-tool results
are retained and exported, increasing sensitive-data retention and quota
pressure. Chrome local storage has a finite default quota; failed writes are
not surfaced reliably to the user.

After this plan, session metadata and bodies are independently addressed,
mutations are serialized, migration is resumable, persisted payloads are
bounded/minimized, and quota failures are visible and recoverable.

## Current state

- <code>src/background/storage.js:43-49</code>:

  ~~~js
  export async function loadSessions() {
    return await readKey(STORAGE_KEYS.SESSIONS, []);
  }
  async function saveSessions(sessions) {
    await writeKey(STORAGE_KEYS.SESSIONS, sessions);
  }
  ~~~

- Create, update, delete, project delete, and import each independently load
  and rewrite that array at <code>storage.js:58-155</code>.
- <code>src/sidepanel/app.js:414-421</code> copies full preview data URLs into
  persisted user entries.
- <code>src/sidepanel/chat.js:597-600</code> stores complete tool results in
  assistant segments.
- <code>src/background/agent.js:216-226</code> can return large document
  snapshots; MCP results retain both rendered and raw objects.
- <code>src/sidepanel/settings-panel.js:809-826</code> exports sessions
  wholesale.
- <code>maxHistoryMessages</code> limits model context only, not persisted
  history.
- Plan 003 establishes explicit originating session IDs. Plan 005 establishes
  validated imported message shapes; use both contracts.

## Target storage model

Use versioned keys:

- a small index containing session metadata only;
- one independently addressable body key per session;
- one migration marker/state record;
- no full-resolution preview image in a session body.

Exact key strings belong in <code>STORAGE_KEYS</code>. Each body record must
include a schema version. Metadata must include ID, project ID, name,
timestamps, message count, and approximate persisted bytes.

Adopt explicit default limits in constants and UI documentation:

- maximum persisted preview thumbnail: 200 KiB each;
- maximum two persisted preview thumbnails per user message;
- maximum persisted tool-result detail: 4,000 characters;
- maximum session body: 1 MiB;
- warning threshold for aggregate extension storage: 8 MiB;
- hard behavior on limit: summarize/drop optional display payloads before
  rejecting user-authored text.

If product evidence requires different values, change them only with tests and
documentation; do not leave limits implicit.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/storage.test.mjs test/storage-migration.test.mjs test/chat-security.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | session create/save/import/export passes |
| Legacy write search | <code>rg -n "saveSessions\\(|STORAGE_KEYS\\.SESSIONS" src</code> | only migration compatibility references remain |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/shared/constants.js</code>
- <code>src/background/storage.js</code>
- <code>src/background/service-worker.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/chat.js</code>
- <code>src/sidepanel/settings-panel.js</code>
- <code>src/sidepanel/index.html</code> and styles for quota/retention UI only
- <code>test/storage.test.mjs</code>
- <code>test/storage-migration.test.mjs</code> (create)
- <code>test/chat-security.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>README.md</code>
- <code>PRIVACY.md</code>
- <code>TESTING.md</code>

**Out of scope**:

- Cloud synchronization or server-side storage.
- Persisting full images in a different store merely to evade the quota.
- Encrypting data without a user-controlled key.
- Redesigning the visible chat UI beyond quota/retention errors.
- Changing model-context compaction except where stored summaries are reused.

## Git workflow

- Branch: <code>codex/009-redesign-session-storage</code>
- Suggested commits:
  - <code>test: cover session migration and concurrency</code>
  - <code>fix: normalize and bound session storage</code>
  - <code>docs: document session retention</code>
- Do not push or publish.

## Steps

### Step 1: Lock the migration and concurrency requirements in tests

Create fixtures for:

- empty legacy store;
- multiple valid projects/sessions;
- valid version-1 imports from plan 005;
- full preview attachments;
- raw read-document, custom, and MCP results;
- partially completed migration;
- interrupted write;
- two updates deliberately interleaved;
- near-quota and quota-exceeded responses.

Assert preservation of user-authored message text, session names, project IDs,
ordering, and timestamps. Assert optional large payloads are summarized under
the documented policy.

**Verify**: migration/concurrency tests demonstrate current lost-update and
oversize behavior before the fix.

### Step 2: Introduce a versioned storage repository

Refactor storage behind a repository API while preserving existing
service-worker message names initially. Implement:

- index load/save;
- body get/put/remove by session ID;
- list by project and list grouped from metadata;
- explicit-session update;
- import/export adapters;
- byte accounting using <code>chrome.storage.local.getBytesInUse</code>;
- structured errors with stable codes.

All session mutations must pass through one service-worker-owned queue. A
failed mutation must not poison later queue entries. Read-only operations may
run concurrently against a stable committed index.

Write the body before publishing matching index metadata; delete in the
opposite safe order with orphan cleanup. Avoid an index entry pointing at a
body that was never stored.

**Verify**: interleaved mutation tests pass repeatedly.

### Step 3: Implement resumable, idempotent legacy migration

On first repository access:

1. Read legacy sessions and migration state.
2. Normalize through plan 005's validator.
3. Persist each body independently and verify it can be read.
4. Append/update its metadata index idempotently.
5. Record progress after each session.
6. After all sessions verify, mark migration complete.
7. Remove the legacy aggregate key only after completion and a final count/ID
   comparison.

On interruption, resume without duplicating IDs. Preserve a diagnostic count
for rejected invalid records. Never include rejected content in logs.

Provide a rollback escape while migration is incomplete by leaving the legacy
key untouched.

**Verify**: tests interrupt after every migration phase and the next run
converges to one correct index/body set.

### Step 4: Minimize persisted attachments and tool results

Keep full preview data only in the transient model request. For history:

- create a bounded thumbnail before persistence;
- enforce count and byte limits;
- retain dimensions/type and a user-visible omitted marker when a thumbnail
  cannot be stored.

Create <code>summarizeToolResultForHistory</code>:

- document reads retain counts/truncation status, not full source;
- diagnostics retain bounded counts and a small bounded display sample;
- custom/MCP results retain status and bounded display text, not raw nested
  payload;
- mutation tools retain a bounded argument/result summary sufficient for the
  existing tool block.

The full result may remain transient in the active model conversation but must
not enter persisted/exported segments.

**Verify**: size tests prove one full preview or maximum document result cannot
exceed the documented persisted limits.

### Step 5: Surface quota, migration, and save failures

Await every save that affects user-visible state. Replace silent/unhandled
save promises with a visible status containing:

- stable error category;
- whether the current in-memory chat remains unsaved;
- suggested actions such as export/delete old sessions;
- retry action where safe.

Warn at the aggregate threshold. Do not silently delete user-authored text to
make room. Provide a storage usage display in session management using
bytes-in-use.

**Verify**: browser fixture simulates quota failure and displays an actionable
error without claiming the session was saved.

### Step 6: Version and minimize export/import

Create a version-2 export manifest with:

- explicit format/schema version;
- normalized session metadata/messages;
- retention/omission markers;
- no model API keys, integration headers, or trusted-auto-run settings.

Continue importing valid version-1 files through migration normalization.
Reject unsupported future versions with a clear error.

**Verify**: v1→v2 import/export round trip and v2 round trip pass; searches of
the export fixture find no credential/header fields.

### Step 7: Update privacy, documentation, and QA

Document storage keys at an architectural level, retention limits, migration,
export contents, quota UI, and deletion behavior. State plainly that local
session history can contain user prompts and bounded assistant/tool summaries.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Fake storage with deterministic interleavings and quota errors.
- Migration interruption at each write/marker phase.
- Duplicate import IDs and invalid records.
- Independent updates to two sessions and concurrent rename/save of one.
- Thumbnail count/byte limits.
- Tool summary rules for every built-in plus custom/MCP.
- Export exclusion of credentials, headers, raw images, and raw tool payloads.
- Browser save failure, retry, usage display, import, export, delete.

## Done criteria

- [ ] No normal mutation rewrites one aggregate sessions array.
- [ ] Concurrent updates cannot lose another committed session mutation.
- [ ] Migration is idempotent, resumable, verified, and preserves valid data.
- [ ] Full previews and raw tool payloads are absent from persisted/exported
  history.
- [ ] Documented per-item, per-session, and warning limits are enforced.
- [ ] Quota/save failures are awaited and visible.
- [ ] Version-1 imports remain supported; exports use version 2.
- [ ] Exports exclude credentials, integration headers, and trust settings.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 009 is marked DONE.

## STOP conditions

Stop and report if:

- Existing records exceed limits in a way that would discard user-authored
  prompt/assistant text rather than optional payloads.
- A migration step cannot be made idempotent with the available Chrome storage
  API.
- Plan 003 did not establish explicit originating session IDs.
- Plan 005 did not establish a versioned import normalizer.
- A required export currently contains credentials or headers; treat that as a
  separate urgent security finding before continuing.

## Maintenance notes

- Add a storage-schema migration for every future incompatible record change.
- Keep limits centralized and tested; do not scatter magic byte counts.
- Reviewers should simulate interruption and concurrency, not only a clean
  migration.
- Future rollback/transaction features should store inverse patches, not full
  document snapshots in chat storage.
