# Privacy Policy for Typst Side Agent

Last updated: 2026-08-08

Typst Side Agent is an independent open-source Chrome extension for assisting
editing workflows on `typst.app`. This policy describes the packaged
extension's behavior. It does not replace the policies of Typst, a configured
model provider, a custom tool operator, or an MCP server operator.

## Core principles

- The extension has no publisher-operated analytics, telemetry, advertising,
  or data-sale service.
- Network destinations are chosen through model, custom-tool, or MCP settings.
- Full project context is sent only as needed for a user-started run or an
  approved tool call.
- Optional large payloads are minimized before local session persistence.

## Data processed

Depending on the user's actions and configuration, the extension may process:

- prompts and assistant chat content;
- live Typst editor text, selected text, workspace hints, and diagnostics;
- optional preview or opened-image attachments;
- model reasoning/content and proposed tool calls;
- custom-tool and MCP schemas, arguments, descriptions, and results;
- model API keys and custom/MCP request headers;
- model, integration, theme, and session settings.

Project content and external/model output are treated as untrusted data. They
are placed in labeled context messages, not inserted into the extension's
trusted system instructions.

## Network transfers

When the user sends a prompt, the selected model endpoint receives the
conversation subset, tool definitions, selected context, and supported image
attachments needed for that run. The model API key is sent only to that model
origin as an Authorization credential.

Custom HTTP endpoints receive the configured headers and a JSON body containing
the exact custom function name and schema-validated arguments. MCP endpoints
receive configured headers, protocol metadata, tool discovery/call requests,
and validated arguments. MCP arguments explicitly marked with the supported
`x-mcp-header` extension are sent as headers instead of JSON fields.

Read-only local tools run automatically. Editor changes default to **Ask**, which
shows a diff and waits for **Apply changes** or **Reject**. The locally stored
**Auto approve** editor setting applies built-in editor changes without that
pause; it does not auto-approve custom HTTP or MCP calls. Those external calls
retain **Approve once**, **Allow for run**, or **Deny** unless the user enables
the trust checkbox for that exact saved integration. Run-level grants expire
when that run terminates. Saved trust is fingerprinted to the integration's
destination, headers, name, schema, and protocol; editing those fields clears it.

HTTPS is required by default. Loopback HTTP is supported for local development.
Using other HTTP origins requires an explicit insecure-origin acknowledgement
for that integration and may expose credentials and project-derived data to
network observers. That acknowledgement is bound to the exact origin and must
be renewed after the origin changes.

The project maintainer does not operate or control user-configured third-party
services. Users should review those services' retention, training, security,
and privacy terms.

## Local storage and retention

The extension uses `chrome.storage.local`. When Chrome supports it, access is
restricted to trusted extension contexts; page/content code uses validated
service-worker routes instead of direct storage access.

Local settings can include model credentials, endpoint URLs, custom headers,
and exact integration trust choices. Session schema v2 stores a metadata index
and separate session bodies containing user prompts, the project-relative file
identity captured for each user message, assistant display text, and minimized
attachment/tool summaries. The file identity is also part of that message's
model context and versioned session export; it does not include document text.
When an agent response changes the
editor, a separate checkpoint journal may temporarily retain one complete copy
of the focused document from before that response's first change. It is used
only for the local **Revert** action. Selecting an older response
may consume later same-chat checkpoint copies newest-first; none are sent to a
model, custom tool, or MCP server as part of the revert workflow. On a later
model turn, each successful public `reverted` receipt produces a fixed
editor-state message saying that the prior response's edits were reverted. That
message does not contain the retained source copy, file label, hashes, or
checkpoint ID.

A second, separately bounded document-snapshot journal supports the compact
**Snapshot** action on the latest completed assistant response. A successful
full agent response stores one complete automatic copy of the focused Typst
document for that project/file and chat; cancelled, failed, and partial
responses do not. Continuing that chat removes the
prior automatic copy when the live document has diverged, and the next
successful full response replaces it. Before any snapshot restore overwrites
the editor, the current complete source is saved as a **Before restore**
recovery point. Snapshot source is used only for local preview, integrity
checking, and guarded editor replacement. It is not sent to a model, custom
tool, or MCP server. A successful restore adds a fixed editor-state message to
later model context, but that message contains no source, file label, hashes,
or snapshot ID.

Persistence limits are:

- at most two locally generated preview thumbnails per user message;
- at most 200 KiB per stored thumbnail;
- at most 4,000 characters of generic tool-result detail;
- at most 1 MiB per session body;
- at most five edit checkpoints and 4 MiB of checkpoint bodies in total;
- at most six document snapshots and 4 MiB of snapshot bodies in total;
- a visible storage warning at approximately 8 MiB aggregate use.

Full preview images remain transient request context and are not copied into
stored history. If a bounded thumbnail cannot be created, an omission marker is
stored. Document reads retain counts/ranges rather than full source snapshots;
diagnostics retain bounded counts/samples; custom/MCP and mutation results retain
bounded status/display summaries rather than raw nested responses.

Versioned session exports contain session records only. They exclude API keys,
model settings, endpoint URLs, integration headers, trust choices, and raw
transient image/tool payloads. Full edit-checkpoint and document-snapshot copies
are also excluded, as are local snapshot-restore context events. Imported
response receipts explicitly show that revert is unavailable
because the local copy was not exported. Imports are shape-validated and bounded. Legacy
document/diagnostics attachment flags are supported only for old-history
display and are never re-sent as fresh model context.

Users can remove retained data by deleting one chat, deleting a project's
chats, clearing extension storage in Chrome, or uninstalling the extension.
Checkpoint copies are additionally removed after a successful revert or when
bounded retention evicts an older checkpoint. Deleting a chat removes its
automatic response snapshot. **Before restore** snapshots and any manual points
saved by an earlier extension version survive chat deletion. They can be deleted
from the Snapshot menu and may also be removed by bounded retention, clearing
extension storage, or uninstalling the extension.

## Display and remote content

Model and imported Markdown is parsed and sanitized locally. Raw HTML and
active elements/attributes are removed, only HTTPS and `mailto:` links remain
clickable, and remote inline images are not loaded by the renderer. Markdown
images are displayed as labeled HTTPS links. The extension does not load or
execute remote JavaScript or WebAssembly; all executable code and renderer
libraries are packaged with the extension.

## Permissions

- `sidePanel`: display the assistant beside the page.
- `activeTab`, `tabs`: identify, validate, message, and open relevant tabs.
- `scripting`: install the packaged main-world Typst editor adapter.
- `storage`: retain settings and bounded session state locally.
- `webNavigation`: follow Typst single-page-app route changes.
- `https://typst.app/*`: read and edit Typst project pages.
- `https://*/*`, `http://*/*`: reach only the model/custom/MCP endpoints that
  the user configures. Runtime endpoint policy still enforces the HTTPS,
  loopback, and explicit-insecure-origin rules described above.

## Security and changes

The extension validates internal message envelopes, binds side effects to the
originating run/tab/session, bounds pending operations, propagates cancellation,
validates tool schemas/arguments, and requires source-owned approval policy.
These controls reduce risk but cannot guarantee the security or availability of
a browser, account, network, or third-party endpoint.

This policy will be updated when behavior or data practices materially change.
Questions may be filed through the project issue tracker:
https://github.com/dbccccccc/Typst-Side-Agent/issues
