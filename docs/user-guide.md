# Typst Side Agent user guide

This guide describes what the extension does in detail: models, context,
built-in tools, editor edits and recovery, custom tools, MCP servers, and local
storage. The [README](../README.md) has the short version.

## Models

Add a model under **Settings → Models**.

| Field | Meaning |
|---|---|
| Name | Local display name. |
| API base URL | OpenAI-compatible base such as `https://api.openai.com/v1`. `/chat/completions` is appended. |
| API key | Sent as the Bearer credential to that model endpoint only. |
| Model ID | Provider model identifier. |
| Supports vision | Allows attached preview images in the request. |
| Reasoning effort | `Default` omits `reasoning_effort`; other choices send it. |
| Allow non-loopback HTTP | Explicit acknowledgement for one exact cleartext origin. |

The provider must support OpenAI-compatible Chat Completions, function tools,
and SSE streaming. Reasoning is recognised from the common
`reasoning_content`, `reasoning`, `reasoning.content`, and `thinking` deltas,
and from inline `<think>...</think>` blocks. Reasoning and answer text are
shown as separate segments.

The built-in agent prompt answers in the language of your latest message unless
that message asks for another output language. Code, Typst syntax, identifiers,
paths, and quoted source are left unchanged unless you ask to translate them.
This policy also applies when you configure a custom system prompt.

## Context and attachments

The **+ Add** menu offers:

- **Editor selection**: the highlighted editor text.
- **Preview screenshot**: the live rendered Typst canvas.
- **Opened image**: the image shown in the preview or asset pane.

Selections and images are refreshed from the originating tab right before a
run starts. The full document and diagnostics are deliberately not attachments:
the model reads them with `read_document` and `read_diagnostics` at tool-call
time, so it always sees fresh data.

Each send records only the identity of the project file that was open, taken
from the Typst breadcrumb without reading document text. Every retained user
turn therefore reaches the model with its own labelled, untrusted file context,
which keeps multi-file conversations unambiguous. If you open another file
before a document read or edit runs, the tool pauses in the panel and asks you
to return to the message's file.

Full preview images are transient model input. Stored history keeps at most
two locally generated thumbnails of at most 200 KiB each; if a safe thumbnail
cannot be produced, history shows an omission marker instead.

## Built-in tools

| Tool | Effect | Approval |
|---|---|---|
| `read_file_structure` | Read the visible Files sidebar hierarchy. Collapsed, unknown, or truncated rows mark the result incomplete. | Automatic |
| `open_project_file` | Ask you to open an exact project file, then retarget later document operations to it. | Automatic |
| `read_document` | Read fresh editor source with numbered lines and bounded paging. | Automatic |
| `read_diagnostics` | Wait 750 ms for compilation, then read Typst and spelling diagnostics until two reads agree. | Automatic |
| `read_typst_docs` | Read the bundled Typst reference pages. | Automatic |
| `replace_lines` | Replace an inclusive line range; empty content deletes the range and one boundary newline. | Ask: review diff. Auto approve: apply |
| `search_replace` | Replace one exact substring. | Ask: review diff. Auto approve: apply |
| `patch_document` | Apply several non-overlapping edits atomically. | Ask: review diff. Auto approve: apply |
| `insert_at_cursor` | Insert text at the captured caret. | Ask: review diff. Auto approve: apply |
| `replace_selection` | Replace the captured selection. | Ask: review diff. Auto approve: apply |

Tool-call JSON is parsed fail-closed and validated again immediately before
dispatch. Invalid or oversized arguments become structured errors and never
reach the editor or a network endpoint. Stateful calls keep the provider's
order; only adjacent `replace_lines` calls are reordered bottom-to-top so line
numbers stay valid.

## Editor edits

The **Editor edits** control above the composer is stored locally and captured
when you press Send. Unknown or legacy values fall back to **Ask**.

In **Ask** mode the worker reads the live editor, resolves the tool into
absolute changes, and shows a unified red/green diff with old and new line
numbers in the panel. The same proposal appears in a read-only diff surface over
the editor. That surface lives outside CodeMirror's editable tree and never
changes the source until you approve. Very large previews show a truncation
notice in the editor while the panel diff stays complete. **Apply changes**
commits exactly the reviewed changes; **Reject** leaves the document untouched.

In **Auto approve** mode the prepared changes are committed without a review
pause. Both modes use the same atomic commit, the same original-text, editor,
and focused-file identity checks, and the same originating-tab revalidation.
Auto approve never changes the approval rules for custom or MCP tools.

### Revert

When a response edits the editor, the worker stores one bounded local copy of
the document from just before that response's first edit. The completed
response then shows a compact **Revert** action, which opens an in-panel
confirmation. Revert is available only while the selected tab, project, chat,
focused file, and complete live document form a verified checkpoint chain.
Reverting an older response first reverts every later agent-edited response in
the same chat, newest first. Manual edits, another chat's edits, file changes,
or a broken chain stop the cascade instead of being overwritten; already
reverted newer steps stay reverted and the panel reports the failed step. On
later turns the model receives a fixed editor-state event after each reverted
response, so it does not treat reverted edits as current.

### Snapshots

After every successful complete response, the worker saves one automatic
snapshot of the focused document. The latest completed response shows a compact
**Snapshot** action beside **Revert**. It lists response and **Before restore**
recovery points for the exact project and file. Restore shows a current-to-saved
diff, revalidates the tab, project, file, and live editor, saves the current
source as **Before restore**, and then performs one guarded whole-document
replacement. Later turns receive a fixed editor-state event telling the model to
read the live document.

When a chat continues, the prior automatic snapshot is removed if the document
has diverged; an agent edit removes it right after the guarded write. **Before
restore** snapshots are file recovery data rather than chat history, so deleting
a chat does not remove them.

## Custom HTTP tools

Configure custom tools under **Settings → Tools**. Names must start with a
letter, contain only letters, digits, and underscores, and must not collide
case-insensitively with another custom tool or a built-in.

Each enabled tool supplies a description, endpoint, optional headers, and an
object-root JSON Schema. The supported schema subset covers boolean schema
nodes and these keywords: `type`, `properties`, `required`,
`additionalProperties` (boolean), `items`, `minItems`, `maxItems`, `enum`,
`const`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `allOf`,
`anyOf`, `oneOf`, plus annotation keywords. Unsupported keywords, excessive
depth or size, malformed patterns, and non-object roots are rejected on save.
Patterns use a conservative linear-time subset: groups, alternation,
backreferences, multiple variable-length quantifiers, and quantifier bounds
above 10,000 are rejected. Arguments are limited to 256 KiB and validated
against the same schema before dispatch.

After approval the extension sends:

```http
POST <configured endpoint>
Content-Type: application/json

{"tool":"<function name>","arguments":{...}}
```

The request times out after 30 seconds. Custom headers are bounded single-line
strings and cannot override transport-managed headers.

## MCP servers

Configure servers under **Settings → MCP**. The client speaks stateless MCP
Streamable HTTP for protocol revision **2026-07-28**; **Auto (current)**
resolves to that revision and older or unknown configured versions fail with a
structured compatibility error.

The client supports JSON and SSE responses, JSON-RPC id correlation,
`tools/list` pagination, bounded discovery, declared cache TTL and scope,
timeouts, and cancellation. Invalid discovered schemas are reported and
omitted. The scalar `x-mcp-header` schema extension maps a validated argument
into a transport header and removes it from the JSON arguments; protected MCP
headers cannot be overridden.

Visible function names combine sanitized labels with stable hashes, for example
`mcp__files_ab12cd__read_file_ef34gh`, so truncation or normalization cannot
cause silent collisions. Routing still uses the exact server id and original
tool name. **Probe tools** shows the negotiated version, valid and rejected tool
counts, page count, and discovery-cache status.

## Approval and trust

Read-only built-ins run automatically. Each custom or MCP call pauses for
**Approve once**, **Allow for run**, or **Deny** unless you trusted that exact
saved integration. Trust is bound to a fingerprint of the integration's name,
destination, headers, schema, and protocol; editing any of them clears the
trust until you review and re-enable it. **Allow for run** lasts only for the
current run.

## Sessions and local storage

Chats are grouped by Typst project. The chat menu supports create, switch,
rename, and delete; **Settings → Sessions** adds cross-project search, project
deletion, storage usage, versioned export and import, and project opening.

**Settings → General → Auto-name sessions** can refresh a generated title on
every send. Only the naming model's final answer text can become a title; a
failed title request shows a copyable error at the top of the panel and never
blocks the main response.

Retention limits:

- two 200 KiB preview thumbnails per user message;
- 4,000 characters of persisted tool-result detail;
- 1 MiB per chat body;
- at most five revert checkpoints and 4 MiB of checkpoint bodies in total;
- at most six document snapshots and 4 MiB of snapshot bodies in total;
- an 8 MiB aggregate warning threshold.

Exports contain versioned chat records only. They never contain API keys,
integration headers, trust choices, raw tool or image payloads, revert document
copies, or document snapshots. An imported revert receipt is shown as
unavailable because its document copy is intentionally absent.
