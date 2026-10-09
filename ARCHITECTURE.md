# Architecture

This document defines the runtime ownership and trust contracts for Typst Side
Agent. Changes to messages, tools, storage, or execution worlds should update
this file and their boundary tests in the same change.

## Runtime topology

```text
Side panel (extension page)
  UI state, safe Markdown renderer, send flow, settings/session controls
             │ chrome.runtime envelopes
             ▼
MV3 service worker
  tab lifecycle, storage router, run admission/planning, provider/custom/MCP fetch
             │ chrome.tabs envelopes
             ▼
Isolated content script
  bounded pending-request map and nonce bridge
             │ window.postMessage + per-document nonce
             ▼
typst.app main world
  CodeMirror/preview/diagnostic adapters and editor mutations
```

The service worker is the authority for settings, sessions, run identity, tool
registry metadata, approvals, endpoint policy, and network dispatch. The main
world owns only live page inspection and editor interaction. The isolated world
does not interpret model data; it correlates bounded requests and responses.

## Module map

| Area | Modules | Owns |
|---|---|---|
| Shared leaves | `src/shared/page-limits.js`, `src/shared/active-file.js` | Page bounds and project-file identity. Dependency-free so the content bridge can embed a generated copy. |
| Shared | `src/shared/protocol.js`, `errors.js`, `constants.js`, `system-prompt.js`, `tool-validation.js`, `endpoint-policy.js`, `trust-policy.js`, `edit-checkpoint.js`, `document-snapshot.js`, `project-tree.js`, `abort.js`, `bounded-response.js` | Message registry and validators, structured errors, limits, schema validation, endpoint and trust policy. |
| Worker entry | `src/background/service-worker.js` | Tab lifecycle, side-panel enablement, and the single message router. |
| Agent | `src/background/agent.js` (facade) over `src/background/agent/` | `run-loop.js` orchestrates a run; `tool-preflight.js` waits for page state and approvals; `read-tool-runner.js`, `editor-tool-runner.js`, `external-tool-runner.js` execute tools; `page-bridge.js` talks to the captured tab; `run-transcript.js` mirrors the stream for persistence; `session-title.js` names chats; `agent-adapters.js` is the injection seam. |
| Storage | `src/background/storage.js` (facade) over `src/background/storage/` | `storage-core.js` owns the adapter seam, the serialized mutation queue, and shared helpers; `session-store.js`, `checkpoint-store.js`, `snapshot-store.js`, `settings-store.js`, `integration-store.js` own one domain each. |
| Transports | `src/background/provider.js`, `src/background/mcp.js` | Provider SSE parsing with bounds; MCP 2026-07-28 Streamable HTTP. |
| Content scripts | `src/content/bridge-protocol.js`, `isolated.js`, `workspace.js`, `diagnostics.js`, `float-controller.js`, `main.js` | Page bridge, isolated correlation, DOM heuristics, and the main-world editor adapter. |
| Side panel | `src/sidepanel/app.js` (composition root), `send-controller.js`, `chat.js` (facade over `markdown.js`, `stream-view.js`, `tool-blocks.js`, `reasoning-block.js`, `revert-control.js`), `snapshot-controller.js`, `session-menu.js`, `quick-attach-controller.js`, `about-dialog.js`, `settings-panel.js` (facade over `settings/`) | UI state, rendering, approvals, recovery actions, settings. |

## Startup order

The manifest loads `bridge-protocol.js` and `isolated.js` at document start.
`bridge-protocol.js` runs first in both worlds. Besides the envelope validators
it publishes `globalThis.__typstAgentShared`, a generated classic-script copy
of the dependency-free shared leaves (`page-limits.js` and `active-file.js`).
`scripts/sync-bridge-shared.mjs` writes that block between fixed markers and
`npm run check:bridge` fails when it is stale, so the page and the worker always
compute file labels and bounds with the same code instead of hand-synchronized
copies.

On every fresh service-worker instance, not only `onInstalled`, the worker
self-heals the persisted dynamic main-world registration to this order:

1. `bridge-protocol.js`
2. `workspace.js`
3. `diagnostics.js`
4. `float-controller.js`
5. `main.js`

The worker also attempts the same idempotent injection into already-open Typst
tabs. If direct `chrome.scripting.executeScript` MAIN-world injection is
unavailable for an existing tab, the isolated bridge detects the missing nonce
handshake after 200 ms and loads the same hard-coded, web-accessible bundle
through short-lived script elements. This repairs install, update,
browser-start, and unpacked-extension reload cases, including stale
registrations retained by Chromium. A main runtime marks itself loaded only
after its protocol and shared-runtime dependencies exist, and every recovery
resource removes its loader element after load.

The isolated script generates a per-document nonce, retries only the bridge
handshake, and queues at most 64 page requests. The main runtime remembers a
bounded set of recent bridge nonces so a replacement isolated context can
handshake without reloading typst.app; each response still echoes the exact
request nonce and request ID. Page unload rejects and clears pending work.

## Trust boundaries

Trusted inputs are packaged extension code, built-in tool metadata, locally
saved user settings, and direct approval actions correlated to an active run.

Untrusted inputs include:

- user prompts and imported chat records;
- Typst document text, selections, diagnostics, and workspace hints;
- model content, reasoning, tool names, IDs, and arguments;
- custom/MCP descriptions, schemas, and results;
- all HTTP/SSE/JSON-RPC responses.

Untrusted project/context data is placed in labeled user-role messages
(`src/background/context.js`). It is not interpolated into the trusted system
prompt (`src/shared/system-prompt.js`). Tool descriptions may help the model
decide what to call, but model wording never controls effect metadata or
approval policy.

All model/imported Markdown reaches the DOM through `renderMarkdownFragment()`
in `src/sidepanel/markdown.js`: Marked parses with raw HTML escaped, DOMPurify
returns a strict DOM fragment, unsafe links are replaced with text, HTTPS and
mailto links receive `noopener noreferrer`, and inline images are not created.
Rendering failure produces a plain text node. The extension's own SVG icons are
constant strings built by `svgIcon()` in `chat-dom.js` and are the only markup
ever assigned through `innerHTML`.

## Message protocol

`src/shared/protocol.js` is the canonical extension message registry. Every
extension-context message uses:

```js
{ type, requestId?, runId?, payload }
```

Requests and responses require `requestId`; run-scoped messages require
`runId`. Exact top-level payload fields and boundary-relevant types are
validated. Unknown types, unknown payload fields, missing fields, invalid
actions, malformed responses, and wrong run identities fail closed. Responses
use either `{ok:true,data}` or `{ok:false,error:{code,message,details?}}`.
Structured errors everywhere are created with `codedError()` from
`src/shared/errors.js`.

| Direction | Message families | Owner |
|---|---|---|
| Panel → worker | settings, sessions, integration registries, context reads, run reserve/start/status/cancel, approvals | `service-worker.js` |
| Worker → panel | active-tab/quick-attach notifications, stream batches, tool/preflight/approval events, terminal events | `app.js` |
| Worker → page | context/preview/diagnostic/probe reads and exact tool execution | isolated/main bridge |
| Page → worker | correlated responses and quick-attach intents | isolated bridge |

Protocol constants must not be duplicated as raw runtime string literals.
`npm run check:imports` also prevents cycles, enforces the layer boundaries
(`shared` ← `background`, `content`, `sidepanel`), keeps `protocol.js` free of
dependencies other than the `page-limits.js` leaf, and keeps the two shared
leaves dependency-free.

## Run lifecycle

1. Send (`src/sidepanel/send-controller.js`) captures an immutable `runId`, tab
   ID, project ID, session ID, history reference, model settings, the normalized
   editor approval mode, refreshed attachments, and an identity-only breadcrumb
   snapshot of the open project file. Before the panel mutates history or saves
   the user turn, it reserves that exact identity with the worker. One reserved
   or active run may own a project/chat pair; unrelated chats remain
   independent. Reservations and pre-start cancellation tombstones have bounded
   counts and expiry (`run-coordinator.js`).
2. Stop and navigation mark the panel send token cancelled. Every preparation
   await rechecks that token, so a cancelled reservation can never dispatch a
   later start. The worker consumes only an exact reservation; cancel-before-
   start prevents tab, provider, custom-tool, MCP, and page work.
3. The worker (`agent/run-loop.js`) creates an independent `AbortController`,
   re-reads the captured tab, and rejects it if it is no longer a Typst page.
4. Custom/MCP discovery builds one registry from exact identities
   (`tool-registry.js`). Visible names cannot overwrite another route; schemas
   are bounded and validated.
5. Trusted system instructions and separately labeled untrusted context/history
   become the provider conversation (`context.js`). Every retained user message
   with a captured file gets its file context directly before it; document-read
   results do not repeat file identity.
6. Provider deltas are parsed with arbitrary chunk boundaries (`provider.js`).
   Adjacent channel text is batched for at most 32 ms; the panel renders at
   most once per frame.
7. Tool calls are bounded, parsed as JSON, schema-validated, and looked up by
   exact visible name. Preflight (`agent/tool-preflight.js`) checks page
   capability on the captured tab. Document reads and editor writes also compare
   the live breadcrumb identity with the send-time file; a mismatch waits for
   the user to reopen that file. Provider order is preserved across opens,
   reads, diagnostics, external effects, and other stateful barriers
   (`tool-execution-plan.js`). Only a contiguous `replace_lines` group is
   reordered bottom-to-top.
8. Read-only built-ins run automatically (`agent/read-tool-runner.js`).
   Editor writes (`agent/editor-tool-runner.js`) resolve against a live editor
   snapshot. Ask mode waits for an exact `(runId, callId)` diff review; Auto
   approve mode skips only that review wait. Both send bounded absolute changes
   plus the captured text/editor/focused-file identity to one atomic MAIN-world
   compare-and-dispatch operation, and both revalidate the originating tab.
   Before the first page commit, the worker durably stages one pre-run document
   checkpoint; later writes advance the same final-state hash. If checkpoint
   staging fails, the page edit is not sent. Stale commits fail closed. The
   apply receipt reports `reviewed_diff: true` only for the exact Ask-mode
   proposal the user approved. External calls (`agent/external-tool-runner.js`)
   retain exact-call approval, configuration-fingerprinted saved trust, and
   in-memory run grants that expire at terminal cleanup. Cleartext consent is
   bound to the exact stored origin and revalidated at the final
   network-dispatch boundary.
9. Tool/provider/page operations share the run signal. Network bodies are
   bounded while their streams are consumed, and oversized readers are
   cancelled. Stop races operations that ignore `AbortSignal`, emits one terminal
   cancellation, and prevents later stream or side-effect work.
10. Done, cancelled, and error paths preserve bounded partial output and save it
    to the captured session, not whichever session is currently visible.

Two runs for different project/chat pairs can coexist without sharing
controller state, approvals, cancellation, tab routing, persistence, or event
acceptance.

### Transcript persistence

Both the worker (`agent/run-transcript.js`) and the panel (`stream-view.js`)
can persist the assistant turn, because a run may outlive the panel. Each
assistant record carries the `runId` that produced it; the worker reconciles by
that id, updating only the completion status of a turn the panel already saved
and appending a turn the panel never saw. Records written before run ids were
stored fall back to a content comparison.

## Revert lifecycle

The checkpoint journal (`storage/checkpoint-store.js`) is worker-owned and
separate from chat bodies. Its write-ahead states are
`prepared → applied → reverting → reverted`. `prepared` records distinguish the
prior committed hash from the next pending hash, so a worker interruption
around a page commit can be reconciled against the live document instead of
guessed. A response stores only a bounded public receipt (`id`, status, file
label, creation time); the original source remains only in the journal.

The panel's compact **Revert** action (`sidepanel/revert-control.js`) first
opens an in-panel confirmation. On confirmation it revalidates the captured
tab/project/session scope, then the request carries only that scope and the
selected checkpoint ID. The worker (`edit-revert.js`) excludes concurrent
agent/revert work on that tab and loads the selected checkpoint plus every
later journal entry from the same chat using durable index order. It processes
them newest-to-selected. For each step it reloads the trusted snapshot,
verifies its SHA-256 integrity, re-reads the complete live document, and
requires its length/hash and focused file to match that step's final state. It
then reuses `PAGE_APPLY_EDIT` for one exact full-document replacement with
fresh editor identity. Any mismatch stops the cascade without a fuzzy merge or
native-undo fallback; previously completed newer steps remain reverted and are
returned as structured partial progress. Each successful step writes a small
tombstone and removes its snapshot body. During a later run, context
construction turns each reverted receipt into a fixed system-role editor-state
event immediately after the assistant response it belongs to. The event
contains no document text, file label, or other receipt-controlled string.

## Document snapshot lifecycle

Whole-document recovery uses a second worker-owned journal
(`storage/snapshot-store.js`) keyed by project and exact focused-file label.
Each entry has bounded public metadata and an independently addressed complete
source body with a SHA-256 integrity hash. Only successful full-run completion
creates a user-facing response snapshot; the panel exposes
list/preview/restore/delete operations through the validated service-worker
protocol (`document-snapshots.js`). Preview reads the current full document and
builds a current-to-saved unified diff without mutation. Restore excludes
concurrent agent/revert work, verifies tab/project/file and snapshot integrity,
commits a **Before restore** rescue snapshot, then reuses `PAGE_APPLY_EDIT` for
an expected-text/editor/file guarded whole-document replacement.

One `automatic` entry is scoped to the latest successful full run in a chat.
Run start compares its hash/length with the live focused document and removes
it only on divergence; a successful agent editor write removes it after the
atomic page commit. Successful terminal completion captures the new live
document and replaces the prior automatic entry. Cancelled or failed runs do
not create one. Chat deletion removes its automatic entry, while manual and
rescue entries survive because they are file recovery data.

After restore, the panel attaches a locally validated editor-state update to
the current display history and persists it. Context construction turns that
metadata into fixed system-role text telling the model to read the live
document. Snapshot-controlled strings never enter that system event, and local
restore metadata plus all snapshot bodies are omitted from session exports.

## Tool policy and transports

Built-in effect metadata is source-owned in `tools.js`: document/diagnostic/doc
reads are automatic and editor mutations are isolated as editor-write effects.
The locally stored editor approval mode is normalized fail-closed to Ask and
captured per run; it never changes external-tool policy. `edit-preview.js`
resolves model arguments into bounded absolute changes and unified hunks
without mutating the page. The MAIN-world preview places a self-contained,
read-only diff surface over the originating editor viewport; no CodeMirror-owned
line or gutter is decorated or resized, and cleanup removes the surface on all
terminal paths. The MAIN-world commit compares the exact captured text and
editor token before one CodeMirror dispatch. Custom HTTP and MCP tools default
to external effects and approval. Persisted trust is keyed to the exact
integration identity (`trust-policy.js`), while **Allow for run** applies only
to the exact external route identity and current run.

`tool-validation.js` implements a deliberately bounded JSON Schema subset. Raw
argument JSON is limited to 256 KiB, must have an object root, and is validated
immediately before dispatch. Unsupported schema keywords are rejected rather
than ignored.

`endpoint-policy.js` accepts HTTPS and loopback HTTP. Other HTTP origins require
an explicit exact-origin acknowledgement. Embedded URL credentials and non-HTTP
schemes are rejected. Custom headers are bounded and cannot replace managed
transport headers.

`mcp.js` implements the declared MCP 2026-07-28 stateless Streamable HTTP
transport. It handles JSON/SSE framing, request IDs, protocol metadata,
pagination, cache declarations, response/page/tool limits, timeouts,
cancellation, and the validated `x-mcp-header` extension. There is no silent
fallback to an older protocol.

## Storage ownership and retention

Only trusted extension contexts access `chrome.storage.local`; startup requests
Chrome's `TRUSTED_CONTEXTS` access level when supported. Content scripts reach
storage only through validated worker routes. Every store shares one adapter
seam and one serialized mutation queue (`storage/storage-core.js`); stores with
cached state register a reset hook so tests can swap adapters safely.

Session schema v2 contains:

- `typstAgent.sessionIndex.v2`: metadata, message counts, and approximate bytes;
- `typstAgent.sessionBody.v2.<id>.<revision>`: one independently addressed,
  immutable bounded body selected by the index record;
- `typstAgent.sessionMigration.v2`: resumable legacy-migration state.

Edit-checkpoint schema v1 contains:

- `typstAgent.editCheckpointIndex.v1`: at most five scoped transaction records;
- `typstAgent.editCheckpointBody.v1.<id>`: the single pre-run document copy for
  an available response-level revert.

Document-snapshot schema v1 contains:

- `typstAgent.documentSnapshotIndex.v1`: at most six scoped entries;
- `typstAgent.documentSnapshotBody.v1.<id>`: one complete source body each.

Creates/updates write a new, versioned body before atomically publishing its
metadata pointer; failed index publication leaves the prior record readable and
cleans the staged body. Deletes remove metadata before the body. Startup
removes orphan bodies. Migration is idempotent and removes the legacy aggregate
only after every valid v2 record and body have been verified.

Persistence preserves user-authored message text subject to the 1 MiB body cap,
but minimizes optional data first (`session-normalization.js`). Stored previews
must carry a locally created thumbnail marker and are limited to two × 200 KiB.
Tool results are reduced to bounded status/count/display summaries (4,000
characters of generic detail). Exports are schema v2 session data only and
exclude all settings and credentials. Import accepts supported v1/v2 shapes,
validates every record, and keeps obsolete attachment flags display-only.
Checkpoint bodies have a separate 4 MiB total budget, are pruned oldest-first
without evicting recent in-flight transactions, and are excluded from exports.
Imported public receipts are normalized to `unavailable` because their local
body is intentionally absent.

## Side panel structure and performance

- `app.js` is the composition root: it creates the controllers, keeps the
  active tab/project/chat in sync, and wires DOM events and worker messages.
- `send-controller.js` owns the Send flow as explicit, re-checked steps and is
  unit-tested with fakes.
- `session-controller.js`, `attachment-controller.js`, `run-ui-controller.js`,
  `transition-coordinator.js`, `registry-controller.js`, `status-controller.js`
  own session commands, attachments, run-event acceptance, async transitions,
  registry mutations, and the status toast.
- `chat.js` renders the transcript and fronts `markdown.js` (the sanitizer
  boundary), `stream-view.js` (live segments), `tool-blocks.js` (tool calls,
  preflight, approvals), `reasoning-block.js`, and `revert-control.js`
  (Revert/Snapshot actions). These modules are exercised against a jsdom
  window in `test/chat-render.dom.test.mjs`.
- `settings-panel.js` fronts `settings/general-settings.js`,
  `model-settings.js`, `integration-settings.js`, and `sessions-settings.js`.
- `float-controller.js` (content) converts selection, pointer, scroll, resize,
  mutation, and route events into coalesced animation-frame updates with no
  whole-page polling.

Stream batches preserve exact reasoning/content ordering. Unfinished Markdown
is appended as inert text using only the new suffix; a completed segment is
parsed and sanitized once. Auto-scroll happens only while the user remains near
the bottom, otherwise **Jump to latest** is shown.

## Adding a message or tool

For a new runtime message:

1. Add one constant and registry classification in `shared/protocol.js`.
2. Add its exact payload validator and structured response behavior.
3. Route it in the single owning boundary; consumers import the constant.
4. Add protocol/static/integration tests, including malformed and stale-run
   cases where relevant.
5. Update the message table above if the family or ownership changes.

For a new tool:

1. Define its model schema and source-owned effect/approval/destination in
   `tools.js`.
2. Add it through `tool-registry.js`; never create a parallel dispatch map.
3. Implement execution in the matching runner under `background/agent/` behind
   the common parse/validate/authorize boundary in `run-loop.js`.
4. Propagate the run signal through every wait, read, and network operation.
5. Define a minimal persisted-result summary and add success, malformed,
   denial, cancellation, collision, and wrong-tab tests.

For a change to `shared/page-limits.js` or `shared/active-file.js`, run
`npm run sync:bridge` and commit the regenerated block in
`content/bridge-protocol.js`.

## Verification contract

`npm run verify` is the required source gate: lint, syntax, import layering,
generated-bridge freshness, line length, vendor integrity, and the Node suites
under coverage with risk-weighted floors that are source-owned in
`scripts/check-coverage.mjs`. The packaged browser smoke starts the MV3 worker
and side panel from an extracted canonical ZIP, exercises the page bridge and
local provider stream, verifies hostile live/imported rendering, then
terminates the MV3 worker under an already-open Typst tab with an intentionally
stale registration and requires cold-start recovery. See
[TESTING.md](./TESTING.md).
