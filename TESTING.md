# Testing

Typst Side Agent is a Chrome MV3 extension, which means some of it we can test with
Node.js alone, and some of it only meaningfully exists inside a real browser
against a real typst.app project. This document describes the full testing
process, from fast pre-commit checks to the manual release checklist.

The testing pyramid:

```
   ┌─────────────────────────┐
   │  Manual release QA      │   ~10 min, in Chrome against typst.app
   ├─────────────────────────┤
   │  Integration smoke      │   optional, CDP/puppeteer (not wired by default)
   ├─────────────────────────┤
   │  Unit tests (node:test) │   `npm test`, <1 s
   ├─────────────────────────┤
   │  Static checks          │   manifest shape, JS syntax, asset paths
   └─────────────────────────┘
```

---

## 1. Static checks

Run on every change. No extra dependencies, no network.

```bash
npm run check      # node --check on every src/**/*.js (see scripts/check-syntax.mjs)
npm test           # also runs the static.test.mjs suite
```

`test/static.test.mjs` covers:

- `manifest.json` is valid JSON, is Manifest V3, declares a module-type
  service worker and a side panel.
- Every path listed under `content_scripts[].js`, `background.service_worker`,
  and `web_accessible_resources[].resources` actually exists on disk.
- Every `src/**/*.js` file (excluding vendored bundles under `**/lib/**` and
  `*.min.js`) parses cleanly with `node --check`.

These tests catch the two most common "broke the extension" mistakes:
**typos in manifest paths** and **syntax errors in a module that only loads
inside Chrome**.

---

## 2. Unit tests

All the browser-independent logic lives in `src/background/` and is exercised
from `test/`:

| Suite                   | Covers                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `test/agent.test.mjs`   | SSE reasoning-chunk extraction across vendor dialects, inline `<think>` splitter, tool-call ordering (`read_diagnostics` last, `replace_lines` bottom-up), session-title sanitiser. |
| `test/context.test.mjs` | System-message composition (default prompt, custom tools, MCP section, vision fallback, selections), history compaction (no-op / truncation / floor), UI-field stripping for the API. |
| `test/tools.test.mjs`   | Built-in registry invariants, custom-tool spec defaults, MCP namespacing / sanitisation / length caps. |
| `test/mcp.test.mjs`     | `renderMcpContent` shape handling (text, resource, fallback JSON). |
| `test/static.test.mjs`  | Static checks described above.                              |

Run them:

```bash
npm test
npm run test:watch       # re-runs on save
```

The runner is the built-in `node --test` — zero dependencies. Target ≥ 80%
coverage of the pure helpers. Things that require `fetch`, `chrome.*`, or the
DOM are explicitly **out of scope** for unit tests.

### When to add a unit test

Add one whenever you:

- Add a new pure helper to `src/background/` (reasoning parsing, tool
  routing, history manipulation, message shaping, …).
- Fix a bug whose trigger can be described as "given input X, produce Y".
- Touch the SSE / inline-think / tool-ordering logic — these are the parts
  most likely to break silently across providers.

Keep them focused on inputs and outputs. Do not reach into module internals or
add mocks for Chrome APIs; if you feel the urge, the function probably wants
to be broken into a pure core + a thin Chrome adapter.

---

## 3. Integration smoke (optional)

Full end-to-end is hard because typst.app requires authentication. Two
pragmatic options if the project grows:

1. **MCP smoke server.** Run a tiny Python/Node MCP server on localhost that
   echoes `tools/list` + `tools/call`, point the extension at it, verify
   discovery and invocation work. This can be scripted but is out of CI scope.
2. **Puppeteer against a logged-in profile.** Launch Chromium with the
   `--load-extension=.` flag and a persistent profile that already has a
   typst.app session cookie, then drive the side panel with CDP. Useful
   before major refactors; not part of the default test loop.

Neither is required for the open-source release. They are documented here so
contributors know the escape hatches exist.

---

## 4. Manual QA checklist (pre-release)

Run against a real typst.app project, ideally one with multiple files, an
image asset, and at least one compile error. Budget ~10 minutes.

### Install & basics

- [ ] `chrome://extensions` → **Load unpacked** on the repo root succeeds
      without warnings.
- [ ] Opening a typst.app project enables the side panel; opening a non-typst
      page disables it.
- [ ] The action icon opens the side panel.
- [ ] First launch with no model configured lands on **Settings → Models**.

### Models & streaming

- [ ] Adding an OpenAI-compatible model and sending "hi" streams back a
      response.
- [ ] Cancel button during streaming stops tokens immediately.
- [ ] A reasoning-capable model shows a separate **Thinking** panel that
      collapses after the answer arrives. Test with:
      - a provider that emits `delta.reasoning_content`
      - a provider that emits inline `<think>…</think>`
- [ ] Setting **Reasoning effort** to `high` is echoed in the request body
      (check DevTools → Network).
- [ ] Turning off **Vision** for a vision-capable model stops image
      attachments from being sent; the system note mentions the fallback.

### Context attachments

- [ ] + Add → Full document attaches a numbered snapshot.
- [ ] + Add → Editor selection attaches the highlighted range.
- [ ] + Add → Preview screenshot captures the rendered canvas.
- [ ] + Add → Opened image works for a PNG/JPEG asset.
- [ ] + Add → Diagnostics includes Improve-panel items **and** CodeMirror lint
      underlines.
- [ ] "Add to agent" / "Add image to agent" pills appear on selection /
      image hover.

### Tools loop

- [ ] Ask the agent to change a specific line. It calls `read_document`, then
      `replace_lines`, and the editor updates.
- [ ] Ask for an edit it can resolve via `search_replace`. Confirm only one
      round of `search_replace` fires.
- [ ] Ask for several coordinated edits → `patch_document` is used.
- [ ] Break the file on purpose, ask the agent to fix. It calls
      `read_diagnostics`, edits, and re-reads diagnostics.
- [ ] Confirm ordering in the tool blocks: inside a single round, any
      `read_diagnostics` call is listed last; two `replace_lines` calls with
      different line numbers apply cleanly without shifting each other.

### Custom tools

- [ ] Add a local HTTP tool (the arXiv example from the README), toggle it
      on, ask a question that invokes it, check the request body in DevTools:
      `{ "tool": "...", "arguments": { ... } }`.
- [ ] Disabling the tool hides it from the next turn.
- [ ] 30 s timeout: a tool that sleeps 31 s returns
      `{ ok: false, error: "The operation was aborted." }`.

### MCP

- [ ] Add a Streamable-HTTP MCP server, **Probe tools** lists the tools.
- [ ] Ask a question that invokes one of the MCP tools. The tool block shows
      the namespaced name `mcp__<server>__<tool>`.
- [ ] Disabling the server removes its tools from discovery on the next turn.

### Sessions

- [ ] Creating a new chat, renaming (pencil + double-click + Escape to
      cancel), deleting.
- [ ] Auto-name sets a ≤ 4-word title only on sessions still named
      `New chat`. Manual rename turns auto-naming off for that session.
- [ ] Settings → Sessions → Manage all chats: rename / delete across
      projects, Delete all for a project, Export → Import round-trip.

### Storage & privacy

- [ ] API keys and tool / MCP headers survive a browser restart.
- [ ] With the extension off, nothing in the tab network is sent to
      configured endpoints.

### Permissions sanity

- [ ] `manifest.json` `host_permissions` still restricted to what the feature
      needs. `https://*/*` and `http://*/*` are used because custom tools can
      POST anywhere the user configures; if we ever stop supporting arbitrary
      endpoints, tighten these.

---

## 5. Release checklist

1. `npm test` is green locally and in CI.
2. Bump `version` in **both** `manifest.json` and `package.json` (keep them
   identical).
3. Update the top section of `README.md` if behaviour changed.
4. Run the manual QA checklist above on the built-from-`main` state.
5. Zip for distribution:
   ```bash
   zip -r typst-side-agent.zip manifest.json src docs icons README.md LICENSE
   ```
   (CI produces this artifact automatically on every push.)
6. Tag: `git tag vX.Y.Z && git push --tags`.
7. Upload the zip to the GitHub release and, if publishing to the Chrome Web
   Store, to the developer dashboard.

---

## 6. Where new testable helpers should go

The test suite relies on helpers that do not touch `chrome.*`, `fetch`, or the
DOM. When you add browser-integrated code, prefer splitting it into a pure
core + a thin adapter:

```
// ✗ Hard to unit-test
export async function fetchAndRenderThing(id) {
  const resp = await chrome.runtime.sendMessage({ type: 'X', id });
  return renderHTML(resp.items);
}

// ✓ Easy to unit-test
export function renderThing(items) { /* pure */ }
export async function fetchAndRenderThing(id) {
  const resp = await chrome.runtime.sendMessage({ type: 'X', id });
  return renderThing(resp.items);
}
```

Then add a unit test for `renderThing` and leave `fetchAndRenderThing` for
manual QA.
