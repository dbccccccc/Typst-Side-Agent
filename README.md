<p align="center">
  <img src="./icons/icon128.png" alt="Typst Side Agent icon" width="96" height="96" />
</p>

<h1 align="center">Typst Side Agent</h1>

<p align="center">
  Multi-step AI assistant for <a href="https://typst.app">typst.app</a>, built as a Chrome Manifest V3 side-panel extension.
</p>

Typst Side Agent works beside the Typst editor. It can stream an answer, read
fresh source and diagnostics, make line-precise edits, inspect bundled Typst
references, attach selections or previews, and call user-configured HTTP or MCP
tools.

The extension is an independent open-source project. It is not affiliated with
or endorsed by Typst GmbH or the official Typst project.

## Safety model

- The active tab, project, chat session, and run ID are captured when Send is
  pressed. Events, approvals, page calls, cancellation, and persistence stay
  bound to that run even if the user changes tabs or chats.
- Document text, selections, diagnostics, workspace hints, model output, and
  external tool output are treated as untrusted content. They are never added
  to the trusted system prompt.
- Read-only built-ins run automatically. The **Editor edits** control above the
  composer defaults to **Ask**, which shows each proposed diff with **Apply
  changes** and **Reject**. **Auto approve** applies built-in editor changes
  immediately, but does not alter custom/MCP network approvals. A custom tool or
  MCP server can bypass per-call approval only when the user explicitly trusts
  that exact saved integration. Editing its destination, headers, name, schema,
  or protocol clears trust until the changed configuration is reviewed again.
- Model, custom-tool, and MCP endpoints must use HTTPS. Loopback HTTP is allowed
  for local development; other HTTP origins require an explicit insecure-origin
  acknowledgement in that integration's form. The acknowledgement is stored for
  that origin only; legacy boolean acknowledgements and changed origins fail closed.
- Model and imported Markdown is parsed locally, sanitized with a strict tag and
  attribute allowlist, and inserted as DOM nodes. Raw HTML, active content,
  unsafe links, and remote inline images are blocked. Markdown images become
  labeled HTTPS links.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for execution worlds, message flow,
trust boundaries, storage ownership, and extension points. See
[PRIVACY.md](./PRIVACY.md) for the data-handling policy.

## Development install

Requirements: Chrome or Edge with Manifest V3 support, Node.js 20.19 or newer, and
npm.

```bash
npm ci
npm run verify
```

The runtime is plain JavaScript, HTML, and CSS; there is no transpilation step.
The npm dependencies are development/test tooling and reproducibly vendored
renderer sources.

For day-to-day development, open `chrome://extensions`, enable **Developer
mode**, select **Load unpacked**, and choose this repository directory. Open a
`https://typst.app/project/...` page and use the toolbar action to open the side
panel.

For a release-equivalent artifact:

```bash
npm run package
npm run package:check
```

Extract `typst-side-agent.zip` and load the extracted directory. The package is
created from one canonical allowlist, uses fixed ZIP metadata, and is checked
for deterministic contents and local-reference resolution.

## Configure a model

Add a model under **Settings → Models**.

The built-in agent prompt answers in the language used by the user's latest
message unless that message requests another output language. Code, Typst
syntax, identifiers, paths, and quoted source remain unchanged unless the user
asks to translate them. This language policy also applies when a custom system
prompt is configured.

| Field | Meaning |
|---|---|
| Name | Local display name. |
| API base URL | OpenAI-compatible base such as `https://api.openai.com/v1`. `/chat/completions` is appended. |
| API key | Sent as the Bearer credential to that model endpoint. |
| Model ID | Provider model identifier. |
| Supports vision | Allows attached preview images in the request. |
| Reasoning effort | `Default` omits `reasoning_effort`; other choices send it. |
| Allow non-loopback HTTP | Explicit acknowledgement for the exact cleartext origin. |

The provider must support OpenAI-compatible Chat Completions, function tools,
and SSE streaming. Reasoning is recognized from common
`reasoning_content`, `reasoning`, `reasoning.content`, and `thinking` deltas, as
well as inline `<think>...</think>` blocks. Reasoning and answer text are kept in
separate display segments.

## Context and attachments

The **+ Add** menu offers:

- **Editor selection** — highlighted editor text.
- **Preview screenshot** — the live rendered Typst canvas.
- **Opened image** — the image currently shown in the preview/asset pane.

Selections and images are refreshed from the captured originating tab before a
run starts. The full document and diagnostics are deliberately not snapshot
attachments: the model uses `read_document` and `read_diagnostics` so those
reads happen at tool-call time.

Each send captures only the then-open project-file identity from the Typst
breadcrumb—without reading document text—and stores it with that user message.
Every retained user turn therefore reaches the model with its own separately
labelled, untrusted file context, which keeps multi-file conversation history
unambiguous. The latest identity is fixed for the run: if the user opens another
file before a document read or editor change, the tool pauses in the panel and
asks them to return to the message file. `read_document` returns document data,
not another file identity or workspace snapshot.

Full preview data is transient model input. Stored history contains at most two
locally generated thumbnails of at most 200 KiB each; if a safe thumbnail cannot
be produced, history shows an omission marker.

## Built-in tools

| Tool | Effect | Approval |
|---|---|---|
| `read_document` | Read fresh editor source with numbered lines and bounded paging. | Automatic |
| `read_diagnostics` | Wait a fixed 750 ms, then read fresh Typst and spelling diagnostics. Takes no parameters. | Automatic |
| `read_typst_docs` | Read bundled Typst reference pages. | Automatic |
| `replace_lines` | Replace an inclusive line range. | Ask: review diff; Auto approve: atomic apply |
| `search_replace` | Replace one exact substring. | Ask: review diff; Auto approve: atomic apply |
| `patch_document` | Apply coordinated, non-overlapping edits atomically. | Ask: review combined diff; Auto approve: atomic apply |
| `insert_at_cursor` | Insert text at the captured caret. | Ask: review diff; Auto approve: atomic apply |
| `replace_selection` | Replace the captured selection. | Ask: review diff; Auto approve: atomic apply |

Tool-call JSON is parsed fail-closed and validated again immediately before
dispatch. Invalid or oversized arguments become structured errors and never
reach the editor or a network endpoint.

The **Editor edits** setting is stored locally and captured when Send is
pressed. Unknown or legacy values fall back to **Ask**. In Ask mode, the worker
reads the live originating editor, resolves the tool into absolute changes, and
displays a unified red/green diff with old/new line numbers. The same proposal
is rendered in a read-only diff surface positioned over the originating editor,
with context, deletion, and insertion rows laid out in normal document flow.
The surface lives outside CodeMirror's editable tree, never decorates or mutates
CodeMirror-owned lines, and keeps the source unchanged until approval. Very
large editor previews show an explicit truncation notice while the
side-panel diff remains complete. **Apply changes** commits exactly those
reviewed changes; **Reject** leaves the document untouched. Editor run grants
are not offered.

In Auto approve mode, the prepared changes are committed without opening the
diff review. Both modes use the same atomic commit, exact original-text/editor
and focused-file identity checks, and originating-tab revalidation. Ask-mode
rows are removed after Apply, Reject, cancellation, timeout, navigation, or any
stale failure.

When a response makes one or more editor changes, the worker stores one bounded
local copy of the document from immediately before that response's first edit.
Later edits in the same run advance the checkpoint's final-text hash without
copying the document again. The completed assistant response then shows
one compact **Revert** action. Clicking it opens an in-panel confirmation before
any document change is attempted. Revert is available only while the selected
tab, project, chat, focused file (when identifiable), and complete live document
form a verified checkpoint chain. Confirming an older response first reverts every
later agent-edited response in the same chat, newest to selected. Every response
uses its own guarded CodeMirror transaction; manual edits, another chat's edits,
file changes, or a broken chain stop the cascade instead of being overwritten.
Already completed newer steps remain reverted and the panel reports the failed
step. Each successful step discards its retained document copy. On later turns,
the model receives a fixed editor-state event immediately after every affected
assistant response, so it does not treat reverted edits as current.

After every successful full agent response, the worker saves one automatic
snapshot of the then-current focused document. The latest completed response
shows a compact **Snapshot** action beside **Revert** (or by itself when that
response made no editor changes). There is no snapshot-creation action in the
composer, and cancelled, failed, or partial responses never receive one.

**Snapshot** opens recent response and **Before restore** recovery points for
the exact project/file. Restore first shows a current-to-saved diff, revalidates
the tab/project/file and live editor, saves the current source as **Before
restore**, and then uses one guarded atomic whole-document replacement. After a
successful restore, later model turns receive a fixed editor-state event telling
them to read the live document; the event contains no source, file label, hash,
or snapshot ID.

When that chat continues, a live hash comparison removes the prior automatic
snapshot if the document has diverged; an agent edit removes it immediately
after the guarded write. A new automatic snapshot replaces it only after the
next successful full response completes. **Before restore** snapshots remain
project/file recovery data rather than chat history, so deleting a chat does
not remove them.

## Custom HTTP tools

Custom tools are configured under **Settings → Tools**. Names must start with a
letter, contain only letters, digits, and underscores, and must not collide
case-insensitively with another custom tool or a built-in.

Each enabled tool supplies a description, endpoint, optional headers, and an
object-root JSON Schema. The implemented schema subset supports boolean schema
nodes and these keywords:

`type`, `properties`, `required`, `additionalProperties` (boolean), `items`,
`minItems`, `maxItems`, `enum`, `const`, `minLength`, `maxLength`, `pattern`,
`minimum`, `maximum`, `allOf`, `anyOf`, and `oneOf`, plus annotation keywords.

Unsupported keywords, excessive depth/size, malformed patterns, and non-object
roots are rejected when saving. Patterns use a deliberately conservative
linear-time subset: groups, alternation, backreferences, multiple variable-length
quantifiers, and quantifier bounds above 10,000 are rejected. Arguments are
limited to 256 KiB and validated against the same schema before dispatch.

After approval, the extension sends:

```http
POST <configured endpoint>
Content-Type: application/json

{"tool":"<function name>","arguments":{...}}
```

The request times out after 30 seconds. Custom headers are bounded single-line
strings and cannot override transport-managed headers.

## MCP servers

MCP servers are configured under **Settings → MCP** and use stateless
Streamable HTTP. This release declares only MCP **2026-07-28**; **Auto
(current)** resolves to that version. Older/unknown configured versions fail
with a structured compatibility error.

The client supports JSON and SSE responses, JSON-RPC ID correlation,
`tools/list` pagination, bounded discovery, declared cache TTL/scope, timeouts,
and cancellation. Invalid discovered schemas are reported and omitted. The
supported scalar `x-mcp-header` schema extension maps a validated argument into
a transport header and removes it from JSON arguments; protected MCP headers
cannot be overridden.

Visible model function names include sanitized labels and stable hashes, for
example `mcp__files_ab12cd__read_file_ef34gh`. The hashes prevent silent
collisions after truncation or normalization; routing still uses the exact
server ID and original tool name.

Use **Probe tools** to see the negotiated version, valid/rejected tool counts,
page count, and discovery-cache status before saving or running a tool.

## Sessions and local storage

Chats are grouped by Typst project. The session menu supports create, switch,
rename, and delete; **Settings → Sessions** adds cross-project filtering,
project deletion, storage usage, versioned export/import, and project opening.

**Settings → General → Auto-name sessions** can refresh a generated title on
every send. If its selected model or title request fails, a copyable,
auto-collapsing error appears in the notification area at the top of the panel;
the main agent response continues independently. Thinking models receive their
configured reasoning effort without the old 24-token completion cap. Only their
final `choices[0].message.content` can become a title; separate or inline
reasoning and alternate response fields are discarded. No local fallback title
is synthesized. Titles use the language of the latest user message, or its
explicitly requested output language, instead of defaulting to English.

Storage schema v2 separates a small metadata index from independently addressed
session bodies and serializes mutations. A legacy aggregate is migrated
idempotently. Session imports validate message/display shapes; legacy document
and diagnostics attachment flags remain display-only and are never reused as
new model context.

Retention limits include:

- two 200 KiB preview thumbnails per user message;
- 4,000 characters of persisted tool-result detail;
- 1 MiB per session body;
- at most five edit checkpoints and 4 MiB of checkpoint bodies in total;
- at most six file-scoped document snapshots and 4 MiB of snapshot bodies in total;
- an 8 MiB aggregate warning threshold.

Exports contain versioned session records only. They do not contain model API
keys, integration headers, endpoint trust choices, or raw transient tool/image
payloads. Revert document copies and document recovery snapshots are
stored in separate local journals and are never exported; an imported response
receipt is therefore shown as unavailable.

## Project structure

```text
manifest.json                     MV3 entry points and permissions
src/shared/protocol.js            message registry, envelopes, validators
src/shared/abort.js               cancellation and timeout helpers
src/background/service-worker.js  tab lifecycle and request router
src/background/agent.js           per-run orchestration and approvals
src/background/edit-preview.js    immutable edit resolution and unified hunks
src/background/edit-revert.js     scoped hash-guarded checkpoint recovery
src/background/document-snapshots.js scoped list/preview/restore/delete recovery
src/background/provider.js        provider SSE transport
src/background/tool-registry.js   exact tool identities and effects
src/background/tool-validation.js bounded schema/argument validation
src/background/mcp.js             MCP 2026-07-28 Streamable HTTP client
src/background/storage.js         transactional session/settings storage
src/shared/edit-checkpoint.js      checkpoint hashing and public receipt policy
src/shared/document-snapshot.js    snapshot kinds, public metadata, context events
src/content/                       isolated/main-world page bridge and editor adapters
src/sidepanel/edit-diff.js         text-only reviewed-diff renderer
src/sidepanel/snapshot-controller.js snapshot popover and restore dialog
src/sidepanel/                     UI, safe renderer, settings, and session controls
scripts/                           verification, vendoring, and deterministic packaging
test/                              unit, integration, static, package, and browser smoke tests
```

## Contributing and release work

Run `npm run verify` for lint, syntax, import architecture, vendor integrity,
unit/integration tests, and risk-weighted coverage floors. Run
`npm run test:browser` for the packaged-artifact MV3 smoke. The browser test
uses local fixtures; it does not require a Typst account or model credential.

The renderer bundles are checked in with exact provenance under
`src/sidepanel/lib/`; update them only with `npm run vendor:update` and verify
with `npm run vendor:verify`.

See [TESTING.md](./TESTING.md) for focused commands, manual QA, and the complete
release checklist. License: [MIT](./LICENSE).
