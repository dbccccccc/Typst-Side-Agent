# Changelog

All notable changes to Typst Side Agent are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and release versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-08-16

This is a substantial safety, recovery, multi-file, storage, and release-
engineering update over 1.0.1. Existing session data is migrated automatically,
but existing non-loopback HTTP model, custom-tool, and MCP endpoints must be
confirmed for their exact origin before use. Existing custom-tool and MCP
definitions are also revalidated against the stricter contracts below.

### Added

- **Project-aware multi-file tools.** Added `read_file_structure` for the
  bounded, visible Typst Files hierarchy and `open_project_file` for exact
  project-relative retargeting. Collapsed, unknown, or truncated tree rows are
  reported as incomplete instead of guessed.
- **Per-message file identity.** Each user message records the project-relative
  file that was open when it was sent. Multi-file history keeps that identity
  adjacent to its original message, including after history compaction.
- **Reviewed editor changes.** Built-in writes now default to **Ask** and show a
  unified red/green diff with old and new line numbers. The same proposal is
  shown in a read-only surface over the originating editor without modifying
  CodeMirror-owned content. **Auto approve** remains available for built-in
  editor tools only.
- **Response-level Revert.** The first edit in a response creates one bounded,
  worker-owned pre-edit checkpoint. Completed responses expose a guarded
  **Revert** action; reverting an older response walks later same-chat agent
  edits newest-first and stops safely at the first broken document chain.
- **Document snapshots and restore.** Successful complete responses create one
  automatic snapshot for the exact project, file, and chat. The **Snapshot**
  menu can preview a current-to-saved diff, restore atomically, delete recovery
  points, and retain a **Before restore** rescue copy.
- **External-call approval controls.** Custom HTTP and MCP calls now offer
  **Approve once**, **Allow for run**, and **Deny**. An exact saved integration
  can be trusted for automatic calls; changing its identity, destination,
  headers, schema, or protocol clears that trust.
- **Tool policy metadata.** Every built-in declares a source-owned effect,
  approval policy, and destination. Human-reviewed receipts distinguish an
  approved diff from auto-approved, revert, and snapshot writes.
- **Bounded JSON Schema validation.** Custom and discovered MCP tools share a
  fail-closed validator for object-root schemas, arguments up to 256 KiB,
  boolean schema nodes, structural `enum`/`const`, arrays, string/number bounds,
  and bounded `allOf`/`anyOf`/`oneOf`. Unsafe or unsupported regex/schema
  constructs are rejected when the integration is saved or discovered.
- **MCP 2026-07-28 transport.** Added stateless Streamable HTTP metadata and
  headers, JSON and framing-correct SSE responses, JSON-RPC ID correlation,
  `tools/list` pagination, bounded discovery caching, timeouts, cancellation,
  tool/page limits, and structured compatibility errors.
- **MCP diagnostics and headers.** **Probe tools** now reports negotiated
  protocol version, accepted/rejected tool counts, pages, and cache state. The
  validated scalar `x-mcp-header` extension can move an argument into a
  protected request header, including the declared non-ASCII wrapper.
- **Collision-resistant MCP names.** Model-visible names include sanitized
  server/tool labels plus stable hashes while routing retains the exact server
  ID and original tool name.
- **Storage schema v2.** Added a metadata index, independently addressed and
  revisioned session bodies, serialized mutations, resumable legacy migration,
  orphan cleanup, storage-usage reporting, and visible quota errors.
- **Bounded portable sessions.** Added versioned v1/v2 import validation and v2
  export records. Stored history minimizes previews and tool results, while
  edit checkpoints, snapshots, credentials, endpoint headers, and trust choices
  stay outside exports.
- **Configurable send shortcut.** General settings can assign Send to Enter,
  Shift+Enter, or Ctrl+Enter; the other Enter combinations insert newlines.
- **Panel status and navigation controls.** Added copyable, dismissible,
  severity-aware notifications, a **Jump to latest** control when scroll-follow
  is paused, and an About dialog with version and project links.
- **Shared runtime protocol.** Added a canonical message registry, correlated
  request/response envelopes, run identity validation, structured errors,
  bounded page requests, and a per-document bridge nonce.
- **Self-healing content bootstrap.** Fresh MV3 workers repair stale dynamic
  registrations and inject the same ordered main-world bundle into already-open
  Typst tabs. The isolated bridge can recover after extension install, update,
  browser restart, or unpacked-extension reload.
- **Deterministic release tooling.** Added one canonical package allowlist,
  fixed ZIP metadata, safe-path and local-reference checks, manifest/package/tag
  version gates, artifact verification, release dependency auditing, vendored-
  library integrity checks, semantic linting, import/cycle checks, and risk-
  weighted coverage gates.
- **Packaged browser verification.** Added a local-fixture MV3 smoke suite for
  bridge startup, streaming, hostile rendering, editor safety, and cold-worker
  recovery without requiring a Typst account or model credential.
- **Project documentation.** Added architecture, changelog, contributing,
  roadmap, security-policy, and third-party-notice documents, including exact
  Marked and DOMPurify provenance and license texts.
- **Typst 0.15.1 reference refresh.** Updated all bundled agent reference topics
  for Typst 0.15/0.15.1 language and compiler changes and recorded their source
  version and review date.

### Changed

- **Run ownership.** Send now reserves an immutable run ID, tab, project, chat,
  model/settings snapshot, attachments, and open-file identity before mutating
  history. The worker admits one owner per project/chat pair while allowing
  unrelated chats to run independently.
- **Tab and file pinning.** Page reads, edits, approvals, events, persistence,
  and cancellation target the tab and chat captured at Send. Document tools
  pause if another file is opened and resume only after the expected breadcrumb
  path is restored; navigation invalidates the run.
- **Cancellation.** Stop and navigation now propagate through reservation,
  discovery, provider streaming, preflight waits, approvals, custom/MCP calls,
  page requests, and persistence. Cancellation is terminal even when it races
  worker startup or an operation that ignores `AbortSignal`.
- **Untrusted context handling.** Typst source, selections, diagnostics,
  workspace hints, model output, imported history, and external tool output are
  carried in labeled context rather than interpolated into trusted system
  instructions.
- **Response language.** Agent and title-generation prompts now request the
  latest user language, or an explicitly requested response language, while
  preserving code, paths, Typst syntax, identifiers, and quoted source.
- **Attachments.** Selection and preview context is refreshed from the captured
  originating tab. Full images remain transient model input; history stores at
  most two locally generated 200 KiB thumbnails per user message and records an
  omission marker when a safe thumbnail cannot be produced.
- **Document reads.** `read_document` reads the file associated with the latest
  message, supports bounded line paging, and no longer returns an unrelated
  workspace snapshot or silently follows whichever Typst tab is active.
- **Diagnostics.** `read_diagnostics` now owns a fixed 750 ms compiler-settling
  delay and bounded stability polling instead of accepting a model-selected
  delay. Results merge line and project diagnostics and expose disjoint compiler,
  spelling, and extraction-status counts.
- **Editor commits.** Ask and Auto approve resolve against the same live
  snapshot and use one atomic compare-and-dispatch transaction guarded by the
  original text, editor identity, focused file, originating tab, and project.
  Stale or oversized edits fail closed.
- **Tool ordering.** Provider order is retained across file opens, reads,
  diagnostics, external effects, and other stateful barriers. Only a safe,
  contiguous group of valid `replace_lines` calls is reordered bottom-to-top.
- **Custom HTTP tools.** Names must be valid and collision-free, headers are
  bounded and cannot replace transport-managed headers, schemas use the
  documented supported subset, arguments are revalidated immediately before
  dispatch, redirects are rejected, and responses are bounded while read.
- **Endpoint policy.** Model, custom-tool, and MCP endpoints require HTTPS by
  default. Loopback HTTP remains available for development; other HTTP origins
  require an acknowledgement bound to that exact origin. Embedded credentials,
  non-HTTP schemes, redirects, changed origins, and legacy boolean consent fail
  closed.
- **MCP configuration.** **Auto (current)** resolves to MCP 2026-07-28. Older or
  unknown configured versions no longer fall through silently, invalid
  discovered schemas are omitted with diagnostics, and protected protocol
  headers cannot be overridden.
- **Provider streaming.** OpenAI-compatible SSE parsing moved behind a bounded,
  cancellation-aware transport that handles arbitrary byte boundaries,
  separated reasoning fields, split inline `<think>` blocks, and accumulated
  tool calls. Malformed, duplicate, or oversized calls fail before dispatch.
- **Stream rendering.** Adjacent reasoning/content deltas are batched without
  reordering. The panel appends only each new suffix as inert text and performs
  one parsed-and-sanitized Markdown render when a segment closes, preserving
  the reader's scroll position.
- **Page observation.** Continuous whole-document polling was replaced by
  event-driven, animation-frame-coalesced updates and targeted observers for
  preview and Files surfaces. CodeMirror mutations no longer trigger broad
  workspace or image scans.
- **Session persistence.** Session lists load metadata without eagerly reading
  every body. Mutations publish a new body before its index pointer, deletes
  publish metadata removal before cleanup, and concurrent or interrupted writes
  preserve the last committed session.
- **History retention.** Session bodies are capped at 1 MiB, generic persisted
  tool detail at 4,000 characters, edit checkpoints at five/4 MiB, and document
  snapshots at six/4 MiB, with an aggregate warning near 8 MiB.
- **Auto-naming.** Generated titles can refresh after later sends but never
  replace a manual rename. Title generation accepts reasoning models without
  the previous 24-token completion cap, uses only final message content, and
  reports failures without interrupting the main response.
- **Side-panel ownership.** Session navigation, attachments, run UI, registry
  mutations, recovery UI, status notifications, and transition coordination
  moved behind focused controllers; worker-owned settings and registry writes
  are transactional.
- **Toolchain.** Raised the supported development floor from Node.js 20 to
  Node.js 22.13 and added Node.js 24 CI coverage. ESLint, locked Playwright,
  DOMPurify, vendored-library verification, packaging, and release-audit commands
  are now declared in `package.json`.
- **CI and publishing.** CI and release workflows use least-privilege
  permissions, immutable action commits, Dependabot coverage, the canonical
  package command, tag/version validation, a high/critical dependency gate, and
  two consecutive packaged Chromium smoke runs before publication. Chrome Web
  Store credentials remain isolated behind the protected publish environment.
- **Documentation and privacy.** Rewrote README, privacy, testing, and release
  guidance to match the shipped trust boundaries, retention rules, recovery
  behavior, MCP contract, and deterministic artifact workflow.

### Fixed

- Prevented an agent run from reading or editing whichever Typst tab, project,
  file, or chat happens to be active after Send.
- Prevented stale panel events, approvals, tool-call IDs, cancellations, and
  terminal saves from being accepted by another run or session.
- Closed pre-start Stop races that could previously allow discovery or provider,
  custom-tool, MCP, or page effects to begin after cancellation.
- Rejected editor applies when the document, CodeMirror instance, breadcrumb
  file, tab route, or reviewed proposal changes before commit; preview surfaces
  now clean up on apply, reject, timeout, cancellation, navigation, and errors.
- Corrected `replace_lines` with empty content to delete exact physical line
  ranges at the beginning, middle, or end of LF and CRLF documents while
  preserving line endings for non-empty replacements.
- Rejected ambiguous or overlapping patch targets before approval, skipped
  no-op changes, and kept distant changes in separate bounded diff hunks.
- Prevented collapsed, unclassified, or truncated Files rows from producing a
  false `complete: true` project tree.
- Preserved project-level compiler failures with no line badge, retained
  compiler-summary fallbacks, and reported parser uncertainty instead of
  treating an unrecognized Improve panel as a clean document.
- Preserved exact reasoning/content/tool ordering across large streams, stopped
  reparsing all accumulated Markdown for every token, and stopped forced
  auto-scroll after the user moves away from the bottom.
- Hardened provider parsing against arbitrary chunk boundaries, duplicate
  tool-call IDs, malformed JSON/SSE, oversized streams or tool arguments, and
  cancellation during both successful and error-body reads.
- Corrected MCP CRLF/comment/multiline SSE framing, request-ID matching,
  pagination, cache scope/TTL handling, header protection, discovery limits,
  timeouts, cancellation, and oversized-response cleanup.
- Prevented concurrent session/settings/registry writes, failed index
  publication, quota errors, duplicate legacy IDs, interrupted migration, and
  failed imports from exposing partial state or orphaning the last committed
  record.
- Made checkpoint and snapshot writes crash-consistent, scope-checked, hash-
  verified, bounded, and recoverable when a worker interruption occurs around
  an editor commit. Partial revert progress is retained and reported instead of
  being rolled back or hidden.
- Repaired extension startup after stale MV3 registrations or cold-worker
  replacement while a Typst tab is already open, without poisoning the main-
  world loaded flag after a transient bridge failure.
- Prevented quick selection/image attachments from crossing their originating
  tab or window and prevented obsolete legacy attachment flags from being sent
  again as live model context.
- Prevented auto-name reasoning or alternate provider fields from becoming a
  session title and routed naming failures to the shared notification area.

### Security

- Parsed model and imported Markdown locally with escaped raw HTML and a strict
  DOMPurify allowlist. Active content, unsafe attributes and links, and remote
  inline images are removed; Markdown images become labeled HTTPS links.
- Bound runs, page requests, quick attachments, approvals, and responses to
  validated IDs and the originating tab/project/session. Unknown protocol
  messages, fields, response shapes, and stale bridge nonces fail closed.
- Kept tool effects, destinations, approval requirements, and reviewed-diff
  provenance in packaged source so model or page output cannot promote its own
  privileges.
- Fingerprinted saved custom/MCP trust to the exact integration and kept
  **Allow for run** grants in memory only until terminal cleanup.
- Revalidated HTTPS/cleartext consent, tool schemas, arguments, headers, and
  route identity at the final network-dispatch boundary; redirects are not
  followed.
- Bounded provider, custom-tool, MCP, page-bridge, attachment, import, session,
  checkpoint, snapshot, and diff work, and cancelled streaming readers as soon
  as a boundary is crossed.
- Restricted `chrome.storage.local` to trusted extension contexts where Chrome
  supports it. Content scripts use validated worker routes instead of direct
  storage access.
- Excluded API keys, integration headers, endpoint/trust settings, full
  transient images/tool payloads, edit checkpoints, and document snapshots from
  session exports. Imported recovery receipts are explicitly unavailable
  without their local trusted bodies.
- Pinned GitHub Actions to immutable commits, reduced workflow permissions,
  isolated Chrome Web Store secrets behind a protected environment, and added a
  fail-closed high/critical dependency audit to CI and release gates.

## [1.0.1] - 2026-05-22

- Added automated Chrome Web Store publication from verified, non-prerelease
  GitHub Releases.

## [1.0.0] - 2026-04-22

- Initial public release.

[Unreleased]: https://github.com/dbccccccc/Typst-Side-Agent/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/dbccccccc/Typst-Side-Agent/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dbccccccc/Typst-Side-Agent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dbccccccc/Typst-Side-Agent/releases/tag/v1.0.0
