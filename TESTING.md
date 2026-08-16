# Testing and release verification

Typst Side Agent combines pure modules, Chrome extension contexts, a
main/isolated-world page bridge, streaming transports, and deterministic release
packaging. The required gates cover each layer; a source-only smoke is not a
substitute for the packaged-artifact test.

## Prerequisites

- Node.js 22.13 or newer (CI tests Node 22.13 and Node 24 LTS)
- npm with a clean `npm ci`
- The Chromium revision installed by the pinned `playwright-core` dependency

Install exact development dependencies:

```bash
npm ci
```

## Required source gate

```bash
npm run verify
```

`verify` runs, in order:

1. `npm run lint` — correctness-oriented ESLint rules for Node, browser, and
   extension globals.
2. `npm run check` — syntax checks for non-vendored source modules.
3. `npm run check:imports` — missing imports, import cycles, raw protocol
   dispatch literals, and the dependency-free shared-protocol leaf.
4. `npm run vendor:verify` — exact Marked/DOMPurify source and provenance
   verification.
5. `npm run coverage` — all root Node suites under coverage, with focused line
   floors for the agent, provider/MCP transports, storage/schema policy, and
   browser-facing float, registry, run, import, and transition controllers.

Use `npm test` as the faster standalone developer command when coverage is not
needed. Coverage percentages include modules loaded by the root Node suites;
browser entry points are additionally protected by extracted controller tests
and the packaged-browser smoke below.

Also run before handoff:

```bash
git diff --check
npm run audit:release
```

The full audit is intentional: Marked and DOMPurify are declared as development
dependencies but their verified artifacts are copied into the shipped extension.
Classify browser-test-only advisories separately from release-reachable renderer
advisories rather than excluding all development dependencies.

## Test suites

`npm test` uses `node:test` and currently covers:

- provider SSE framing across arbitrary byte boundaries, reasoning dialects,
  malformed records, tool-call bounds, HTTP errors, and cancellation;
- independent agent runs, captured-tab routing, Ask/Auto approve editor policy,
  external approvals, cancellation, and ordered terminal events;
- edit preparation for all five editor tools, unified hunk generation, inert
  diff rendering, exact editor/text/file commit guards, and stale-preview rejection;
- one-snapshot multi-edit runs, checkpoint state/retention, hash-conflict
  refusal, newest-to-selected cascade ordering, partial-step reporting,
  interrupted commit/revert recovery, export exclusion, and chronological
  model-context notification after successful reverts;
- file-scoped response snapshots, automatic full-response capture and divergence
  invalidation, bounded retention, rescue-first guarded restore, diff preview,
  export exclusion, and fixed model-context notification after restoration;
- exact protocol envelopes, payload fields, response errors, and run identity;
- built-in/custom/MCP registry collisions, source-owned effects, supported JSON
  Schema validation, fail-closed arguments, and protected headers;
- MCP 2026-07-28 JSON/SSE transport, JSON-RPC correlation, pagination,
  discovery caching, metadata, response limits, timeouts, and cancellation;
- transactional session create/update/delete, legacy migration, bounded
  thumbnails/results, malformed imports, storage status, and trusted access;
- stream batching, frame/event controller behavior, and absence of the old
  continuous main-world polling interval;
- ordered MAIN-world recovery through web-accessible extension files when an
  already-open Typst tab never completes the normal nonce handshake;
- manifest references, immutable workflow action pins, permissions, version
  parity, bridge order, deterministic package contents, forbidden paths, and
  ZIP safety.

Focused examples:

```bash
node --test test/agent-integration.test.mjs
node --test test/edit-preview.test.mjs test/edit-diff-render.test.mjs
node --test test/edit-revert.test.mjs test/chat-checkpoint.test.mjs
node --test test/document-snapshots.test.mjs test/storage.test.mjs
node --test test/tool-validation.test.mjs test/tool-policy.test.mjs
node --test test/provider.test.mjs test/mcp-transport.test.mjs
node --test test/storage.test.mjs
node --test test/protocol.test.mjs test/stream-batching.test.mjs
node --test test/package.test.mjs
```

Add a focused regression whenever a defect has a reproducible input. Browser
adapters should expose pure or injected-adapter seams so cancellation, malformed
input, and concurrency can be tested without relying only on manual QA.

## Packaged browser smoke

```bash
npm run test:browser
```

The smoke test does not use the source checkout as the extension directory. It:

1. creates the canonical deterministic ZIP in a temporary directory;
2. extracts that artifact with a bounded store-only ZIP reader;
3. loads the extracted directory as an MV3 extension in a fresh profile;
4. confirms the service worker and side panel start;
5. serves a local intercepted `typst.app` fixture and exercises the
   isolated/main-world editor bridge;
6. streams a local intercepted provider response through the real agent path;
7. verifies the editor permission control defaults to Ask, persists Auto approve,
   restores Ask, then drives a real editor tool call and verifies both the
   side-panel unified diff and 28 visible, ordered insertion rows in the
   read-only editor diff surface; confirms proposed text stays outside the
   editable source and no CodeMirror line is decorated, clicks Apply, confirms
   the buffer changes, and confirms the diff surface is removed;
8. verifies live and imported hostile Markdown cannot create active elements,
   unsafe links, or remote image requests, and verifies plain-text fallback;
9. intentionally persists a stale main-world registration, terminates the MV3
   worker beneath the still-open Typst fixture, wakes it through a browser
   event and fresh panel, and confirms registration, nonce handshake, and
   document reads recover without reloading the original page;
10. checks for side-panel page errors and forbidden external requests.

On CI, Chromium is installed with:

```bash
npx --no-install playwright-core install --with-deps chromium
```

The smoke uses the pinned Playwright Chromium because branded Chrome and Edge
do not support the command-line extension sideload flags required by this test.
Run it twice consecutively before release to catch service-worker
startup/order races:

```bash
npm run test:browser
npm run test:browser
```

## Deterministic package gate

```bash
npm run package
npm run package:check
```

`npm run package` is the only packaging implementation. It reads one canonical
root set, rejects symlinks/hidden/traversal/sensitive paths, verifies manifest
and side-panel references, verifies local links in every packaged Markdown
file, enforces exact `manifest.json`/`package.json` version parity, optionally enforces a release
tag, sorts entries, and fixes ZIP timestamps/permissions.

`package:check` compares the archive's exact ordered entry set with the
canonical set and then rebuilds it byte-for-byte. For the release gate, also
prove two clean package runs have the same SHA-256:

```powershell
npm run package
Get-FileHash -Algorithm SHA256 .\typst-side-agent.zip
npm run package
Get-FileHash -Algorithm SHA256 .\typst-side-agent.zip
npm run package:check
```

The artifact includes manifest, source, exact third-party license texts, bundled
Typst docs, icons, public project/release/security documents, and the project
license. It excludes tests, dependencies, workflows, git data, credentials,
browser profiles, internal planning material, and logs.

## Manual pre-release QA

Use the extracted `typst-side-agent.zip`, a real multi-file Typst project, a
project with an image, and at least one compile error. Keep DevTools open for
the side panel and service worker.

### Startup and tabs

- [ ] The extracted artifact loads without extension errors; service worker and
  side panel start.
- [ ] The panel is enabled on Typst project routes and disabled elsewhere,
  including after SPA navigation.
- [ ] Open two Typst projects. Start a run in A, switch to B, and confirm reads,
  edits, approvals, stream events, and persistence stay with A.
- [ ] Start independent runs from two panel windows if supported; stopping one
  must not stop, approve, or persist the other.
- [ ] Start two sends for the same chat from separate panels. Exactly one is
  admitted; the rejected panel must not append or persist a user turn.

### Models, rendering, and cancellation

- [ ] A configured OpenAI-compatible provider streams content; a reasoning
  provider renders a separate Thinking segment.
- [ ] Reasoning effort `Default` is omitted; a non-default choice is sent.
- [ ] Stop during initial fetch, SSE streaming, MCP discovery/call, custom-tool
  response read, preflight wait, and approval wait. Each path terminates once,
  retains visible partial output, and performs no later side effect.
- [ ] Stop or switch chats while the initial session save is pending. The
  reserved run must never reach provider discovery or page/tool dispatch.
- [ ] Scroll upward during a long stream: the panel does not force-scroll and
  **Jump to latest** appears. Returning near the bottom resumes follow mode.
- [ ] Paste model/imported Markdown containing raw HTML, event attributes,
  `javascript:`, cleartext links, forms, and images. It must remain inert and
  must not fetch the image URL.

### Context and editor tools

- [ ] Ask in several non-English languages and verify plans, explanations, and
  final responses follow the latest user language unless that message requests
  another output language. Code, Typst syntax, paths, and quoted source must not
  be translated implicitly.
- [ ] **+ Add** contains only editor selection, preview screenshot, and opened
  image. There are no Full document or Diagnostics snapshot actions.
- [ ] Selection and image hover quick-add controls respond to selection,
  pointer, scroll, resize, route, and relevant DOM changes without continuous
  whole-page polling.
- [ ] A long streamed answer remains inert while arriving, renders sanitized
  Markdown when its segment closes, and typing in CodeMirror does not trigger
  preview or Files-tree cache scans.
- [ ] In one provider tool batch, open/read file A and then open/read file B;
  each read must target its preceding open. Empty `replace_lines` calls must
  delete first, middle, final, multi-line, only-line, and trailing-empty ranges.
- [ ] Ask-mode edit receipts report `reviewed_diff: true`; Auto, restore, and
  revert receipts report false while retaining the same stale-file/text guards.
- [ ] Attached previews refresh from the originating tab immediately before
  Send. Non-vision models receive the documented text fallback.
- [ ] `read_document`, `read_diagnostics`, and `read_typst_docs` run
  automatically and return fresh/bounded results. `read_diagnostics` accepts
  only `{}` and always waits the fixed 750 ms compiler-settling interval.
- [ ] Send messages from two different project files, reload the panel, and
  verify each retained user turn still gives the model its own send-time file
  path. Capturing that identity must not return editor source.
- [ ] Send a message with one project file open, then switch files before
  `read_document` or an editor tool runs. The tool must pause with the original
  path, resume after that file is reopened, and never expose `active_file` or a
  workspace snapshot in the `read_document` result.
- [ ] The **Editor edits** control sits above the composer, defaults to **Ask**,
  survives a panel/extension reload, and cannot be changed during a run. Unknown
  stored values fall back to Ask.
- [ ] In Ask mode, every editor mutation pauses with a unified diff, file label,
  old/new line numbers, and addition/deletion counts. Test all five edit tools,
  multi-hunk patches, **Apply changes**, and **Reject**; editor changes never
  show a run grant.
- [ ] In **Auto approve** mode, each built-in editor mutation applies without a
  diff/approval pause, pauses on a focused-file mismatch, and still rejects
  stale text, editor, tab, and project state. Custom HTTP and MCP calls must
  continue to use their own approval/trust policy.
- [ ] While approval is open, a read-only diff surface covers the originating
  CodeMirror viewport. Old rows are red, proposed rows are green, old/new line
  numbers are visible, rows do not overlap, proposed text remains outside the
  editable DOM, and the document text is unchanged. Apply, Reject, cancel,
  timeout, and stale failures remove the surface.
- [ ] While a diff is open, switch files before clicking Apply. The commit must
  pause, name the message file, and retry only after that file is reopened.
  Editing the source or navigating to a different project must still fail stale
  without changing either document. Approval buttons must have no effect after
  cancellation or another run.
- [ ] Malformed/missing/wrong-type tool arguments cause structured errors and no
  editor change. Multiple line edits apply bottom-to-top; diagnostics run last.
- [ ] A response with multiple editor tool calls shows one compact **Revert**
  action and restores the document to its state before the first call.
  Clicking it must open an in-panel confirmation with **Cancel** and **Revert
  changes** actions; no native browser dialog should open, and Cancel must leave
  the document untouched. Confirming an older response reverts later same-chat responses newest-first and
  marks every affected response **Changes reverted**. The action is disabled
  during another run. Switching project/file/session, inserting manual work
  between checkpoints, or breaking any step must stop there without touching
  unverified older text; completed newer steps stay reverted and an error is
  shown. Reload around edit commit and revert commit, then retry to verify
  `prepared`/`reverting` recovery. On the next turn, confirm the agent knows all
  successfully reverted responses are no longer current.
- [ ] Complete an agent response and verify one compact **Snapshot** action
  appears beside **Revert** on that response, with no snapshot action in the
  composer. Cancelled, failed, and partial responses must not receive the
  action. Complete another response and verify only the latest completed
  response keeps it.
- [ ] Open **Snapshot**, verify the response snapshot's file/time/type, preview
  the diff, restore it, and confirm the current document appears as **Before
  restore**. Switching file/project/chat or editing after preview must fail stale
  without overwriting the live editor. Confirm a restored snapshot produces a
  fixed next-turn editor-state event and the agent reads the current document
  rather than assuming old source.
- [ ] Delete a recovery point and verify confirmation appears inside the side
  panel with **Cancel** and **Delete** actions. No native browser confirmation
  dialog should open. Cancel preserves the point; Delete removes it and returns
  to the refreshed recovery list.
- [ ] Continue without changing the document and verify the response snapshot is replaced
  after the next full response. Change the document before continuing, and also
  let the next agent edit it; in each case the prior automatic snapshot must be
  removed on divergence. Cancellation/error must not create a new automatic
  snapshot. **Before restore** snapshots must survive chat deletion.

### Endpoint, custom-tool, and MCP policy

- [ ] HTTPS and loopback HTTP save normally. Non-loopback HTTP fails until the
  exact insecure acknowledgement is selected. Embedded credentials, non-HTTP
  schemes, multiline headers, and protected-header overrides are rejected.
- [ ] A custom name that collides with a built-in or another custom name fails.
  Unsupported schema keywords and invalid required/type constraints fail before
  the tool is exposed.
- [ ] An untrusted custom tool pauses before its first network request. Approve,
  deny, run-grant, persisted exact-integration trust, 30-second timeout, and
  Stop behavior all match the UI.
- [ ] MCP Probe reports protocol 2026-07-28, page count, valid/rejected schema
  counts, and cache status. JSON and SSE servers paginate correctly.
- [ ] MCP visible names are collision-resistant; routing uses the intended
  original server/tool. Test `x-mcp-header`, protected headers, mismatched IDs,
  unsupported protocol, response limit, timeout, and cancellation.

### Sessions, storage, and imports

- [ ] Create, switch, rename, delete, delete-project, search, open-project,
  auto-name, export, and import work across projects. With auto-name enabled,
  every send refreshes the generated title. A failed title request shows a
  copyable, auto-collapsing error at the top without stopping the main response.
  A reasoning model must receive its configured effort and name from final text
  after thinking. Only `choices[0].message.content` is accepted; reasoning,
  legacy completion, Responses API, and `<think>` fields must never become titles.
  The title follows the latest user's language or explicitly requested output
  language and must not default to English because the title prompt is English.
- [ ] Interrupt/reload during legacy migration and retry; the final v2 index and
  bodies contain every valid session exactly once.
- [ ] Two overlapping renames/saves do not lose either session. A failed
  oversized save leaves the previous body/index usable and displays the error.
- [ ] Sent images persist only as marked bounded thumbnails (maximum two) or a
  visible omission marker. Raw document/custom/MCP payloads are absent from the
  export; tool display summaries are bounded.
- [ ] Storage usage and the 8 MiB warning render. Version-1 import remains
  display-compatible; malformed message/segment/image records are rejected.
- [ ] Export JSON contains sessions only—no API keys, headers, endpoint trust,
  model/integration settings, checkpoint document bodies, snapshot bodies, or
  local snapshot-restore context events. Importing a
  response receipt shows revert as unavailable.

## Release checklist

1. Merge only after CI passes `npm run verify`, installs Chromium, runs the
   packaged browser smoke twice, and builds the canonical artifact.
2. Set the same `X.Y.Z` version in `manifest.json` and `package.json`; run
   `npm ci` so the lockfile agrees.
3. Update README, ARCHITECTURE, PRIVACY, TESTING, and CHANGELOG for behavior or
   data-flow changes. Update vendored code and license texts only through the
   vendor script.
4. Run locally:

   ```bash
   npm ci
   npm run verify
   npm run audit:release
   npm run test:browser
   npm run test:browser
   npm run package
   npm run package:check
   git diff --check
   ```

5. Confirm a second clean package run has the same SHA-256, then complete the
   manual checklist against the extracted artifact—not the source tree.
6. Create tag `vX.Y.Z` at the reviewed commit. A mismatched tag causes the
   package command to fail before publishing.
7. Publish a non-prerelease GitHub Release. Tag-only pushes and prereleases do
   not publish to the store.
8. The release workflow checks out the release tag, runs `npm ci`,
   `npm run verify`, two packaged browser smokes, packaging with `--expected-tag`,
   and `npm run package:check` in an unprivileged build job. Only the verified ZIP
   artifact then enters the protected `chrome-web-store` publishing job. Configure
   required reviewers and store credentials on that environment.
9. Verify the Chrome Web Store upload/review result and download the workflow
   artifact to confirm its SHA and contents match the reviewed release.

All GitHub Actions are pinned to immutable 40-character commits and workflows
default to `contents: read`. Any permission increase, action update, package-root
change, or release-environment change requires explicit review.
