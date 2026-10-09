<p align="center">
  <img src="./icons/icon128.png" alt="Typst Side Agent icon" width="96" height="96" />
</p>

<h1 align="center">Typst Side Agent</h1>

<p align="center">
  A multi-step AI assistant for <a href="https://typst.app">typst.app</a>, running in Chrome's side panel.
</p>

Typst Side Agent sits beside the Typst editor. It streams answers from any
OpenAI-compatible model, reads the live source and compiler diagnostics, makes
line-precise edits that you review as a diff before they land, keeps revert
points and document snapshots, and can call your own HTTP tools or MCP servers.

It is an independent open-source project and is not affiliated with or
endorsed by Typst GmbH.

## Highlights

- **Reviewed edits by default.** Every editor change is shown as a unified
  diff, both in the panel and over the editor itself, and applies only when you
  click **Apply changes**. **Auto approve** is available for built-in edits.
- **Recovery built in.** Each response that edits the document gets a one-click
  **Revert**, and every completed response saves a document **Snapshot** you
  can preview and restore.
- **Multi-file aware.** The agent can read the project tree, ask you to open a
  file, and keeps track of which file each message referred to.
- **Bring your own model and tools.** Any OpenAI-compatible endpoint with
  function calling and SSE streaming works. Add custom HTTP tools or MCP servers
  from Settings; each external call waits for your approval unless you trust
  that exact integration.
- **Untrusted by design.** Document text, diagnostics, model output, and tool
  results never enter the trusted system prompt, Markdown is sanitized before it
  reaches the DOM, and every message between extension contexts is validated.

## Install

Install from the
[Chrome Web Store](https://chromewebstore.google.com/detail/eljacjoifoamnmbclmhlpcdabdioleab),
or load the repository as an unpacked extension (see **Development** below).

## Quick start

1. Open the side panel from the toolbar action on any `https://typst.app/project/...` page.
2. Add a model under **Settings → Models**: a name, the OpenAI-compatible base
   URL (for example `https://api.openai.com/v1`), an API key, and the model id.
3. Open a Typst project, type a request, and press Send. The agent reads what
   it needs through tools, proposes edits as diffs, and checks diagnostics.

The [user guide](./docs/user-guide.md) explains every tool, setting, approval
rule, and retention limit in detail.

## Safety model in brief

- The tab, project, chat, and run are captured when you press Send. Events,
  approvals, cancellation, and persistence stay bound to that run even if you
  switch tabs or chats.
- Read-only tools run automatically. Editor writes follow your **Editor edits**
  setting (**Ask** by default). Custom HTTP and MCP calls require per-call
  approval unless you explicitly trust that saved integration; editing the
  integration clears the trust until it is reviewed again.
- Model, tool, and MCP endpoints must use HTTPS. Loopback HTTP is allowed for
  local development; any other cleartext origin needs an explicit, per-origin
  acknowledgement.
- API keys and chats are stored only in the browser's local extension storage.
  Session exports never include keys, headers, or trust choices.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the execution worlds, message
protocol, and trust boundaries, and [PRIVACY.md](./PRIVACY.md) for data handling.

## Development

Requirements: Node.js 24.15 or newer, npm, and a Chromium with Manifest V3 support.

```bash
npm ci
npm run verify
```

The runtime is plain JavaScript, HTML, and CSS with no build step. Load the
repository directory with **Load unpacked** on `chrome://extensions`, or build
the release-equivalent archive:

```bash
npm run package
npm run package:check
```

| Command | Purpose |
|---|---|
| `npm test` | Fast Node test suite, including jsdom tests of the side panel. |
| `npm run verify` | Lint, syntax, import layering, generated-bridge sync, line length, vendor integrity, tests with coverage floors. |
| `npm run test:browser` | Load the packaged artifact in pinned Chromium and exercise the real page bridge. |
| `npm run audit:release` | Fail on unwaived high or critical npm advisories. |
| `npm run sync:bridge` | Regenerate the shared-runtime block in the content-script bridge after changing a shared leaf module. |

[TESTING.md](./TESTING.md) covers the gates, manual QA, and the release
checklist. [CONTRIBUTING.md](./CONTRIBUTING.md) has the change guidelines.

## Project structure

```text
manifest.json                      MV3 entry points and permissions
src/shared/                        protocol, limits, validation, and trust helpers shared by every context
src/background/service-worker.js   tab lifecycle and the message router
src/background/agent/              run loop, preflight waits, tool runners, transcript
src/background/storage/            settings, sessions, checkpoints, snapshots, integrations
src/background/mcp.js              MCP Streamable HTTP client
src/background/provider.js         OpenAI-compatible SSE transport
src/content/bridge-protocol.js     page bridge adapter with a generated copy of the shared leaves
src/content/main.js                CodeMirror, preview, and diagnostics adapters in the page
src/sidepanel/app.js               composition root
src/sidepanel/send-controller.js   the Send flow as checked steps
src/sidepanel/chat.js              transcript rendering facade (markdown, streaming, tools, revert)
src/sidepanel/settings/            settings tabs
scripts/                           verification, generation, vendoring, packaging
test/                              unit, integration, DOM, static, package, and browser smoke tests
docs/                              user guide and bundled Typst reference
```

## Release history and roadmap

Releases are recorded in [CHANGELOG.md](./CHANGELOG.md); maintenance
directions live in [ROADMAP.md](./ROADMAP.md). Report vulnerabilities through
[SECURITY.md](./SECURITY.md), never in a public issue.

## License

Typst Side Agent is licensed under [MIT](./LICENSE). Bundled renderer libraries
and their license texts are listed in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
