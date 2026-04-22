# Typst Side Agent

A multi-step AI coding assistant for [typst.app](https://typst.app), packaged as
a Chrome (Manifest V3) extension. It opens in the side panel beside your typst
editor and can:

- Read the live editor (with line numbers and workspace UI hints)
- Edit the document with line-precise tools and a multi-edit `patch_document`
- Capture the live preview (rendered Typst canvas, or an opened image asset)
- Read editor lint underlines and the **Improve** sidebar as diagnostics
- Run a `read_diagnostics` loop that lets the agent fix what it broke
- Be extended with **custom HTTP tools** and **MCP servers**

**Disclaimer.** Typst Side Agent is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Typst GmbH, [typst.app](https://typst.app/), or the official Typst typesetting system and open-source project.

---

## Install (development)

1. Build is not required: this extension is plain ES modules + HTML + CSS.
2. Open `chrome://extensions`, enable **Developer mode**, and click
   **Load unpacked**. Select this repository's root folder (the directory that contains `manifest.json`).
3. Open a project on `https://typst.app/project/...`. The extension's side panel
   becomes available in that tab.
4. Open the side panel from Chrome's toolbar. The first time, it opens the
   **Settings → Models** tab automatically because no model is configured.

## First-time setup

Add at least one model under **Settings → Models**:

| Field             | Example                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Name              | `GPT-4o`                                                         |
| API base URL      | `https://api.openai.com/v1`                                      |
| API key           | `sk-...`                                                         |
| Model ID          | `gpt-4o`                                                         |
| Vision            | check if the model can accept images                             |
| Reasoning effort  | `Default` omits `reasoning_effort` (regular or any model); `minimal/low/medium/high` sends `reasoning_effort` for providers that support it |

The extension talks to OpenAI-compatible `/chat/completions` endpoints with
`tools` (function-calling) and SSE streaming. Anything that speaks the OpenAI
Chat Completions wire format works (Together, OpenRouter, Groq, vLLM, llama.cpp
servers in OAI mode, etc.).

### Thinking models

The agent has first-class support for "thinking" / "reasoning" models. When the
provider streams reasoning tokens, the side panel renders them in a separate
collapsible **Thinking** block above the answer, with a live pulsing indicator.
Reasoning never gets folded back into the assistant message that the model sees
on the next turn, so it doesn't poison subsequent rounds.

Recognised SSE shapes:

- `delta.reasoning_content` — DeepSeek-R1, Qwen-QwQ, Moonshot Kimi-K2, etc.
- `delta.reasoning` (string) — OpenRouter, Together, …
- `delta.reasoning.content` (object) — newer OpenAI-compat servers
- `delta.thinking` — some llama.cpp / vLLM proxies
- Inline `<think>…</think>` tags inside `delta.content` — open-weights models
  that don't separate the channels; the extension routes them to the reasoning
  channel automatically

Setting **Reasoning effort** to anything other than **Default** adds the standard
`reasoning_effort` field to outgoing requests. Providers that don't recognise
the field generally ignore it, so it is safe to leave at **Default** for hybrid
models.

---

## Sending context to the agent

The composer has an **+ Add** button that attaches one or more of:

- **Editor selection** – the currently highlighted text. You can also click the
  floating "Add to agent" pill that appears next to a selection on the page.
- **Preview screenshot** – the rasterized Typst preview canvas.
- **Opened image file** – the underlying image when typst.app is showing an
  asset (PNG / JPEG / SVG) in the preview column. A small "Add image to agent"
  pill also appears on hover.

For the full document and diagnostics, the model uses **`read_document`** and
**`read_diagnostics`** instead so each read is fresh at call time.

Preview attachments are refreshed from the page right before sending so you
never send a stale screenshot.

---

## Built-in tools

| Name              | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `read_document`   | Returns the current editor content with line numbers.               |
| `read_diagnostics` | Merged diagnostics (Improve panel + editor lints). Optional `delay_ms` (default 0) to wait for recompile after edits. |
| `read_typst_docs` | Reads bundled Typst grammar reference pages (`docs/typst/`). Call with no `topic` to list topics; call with a `topic` id like `markup`, `math`, `scripting`, or `cheat-sheet` to read that page. |
| `replace_lines`   | Replaces a `[start_line, end_line]` range with new content.         |
| `search_replace`  | Replaces the first occurrence of a literal string.                  |
| `patch_document`  | Atomically applies multiple non-overlapping `search`/`replace` edits.|
| `insert_at_cursor`| Inserts text at the caret.                                          |
| `replace_selection`| Replaces the current selection.                                    |

The agent loop runs up to 32 rounds per turn. `replace_lines` calls are sorted
bottom-to-top so earlier edits do not invalidate later line numbers, and
`read_diagnostics` is always the last call in a batch.

---

## Custom tools

Extend the agent with your own HTTPS endpoints. Defined under
**Settings → Tools**:

| Field        | Notes                                                       |
| ------------ | ----------------------------------------------------------- |
| Function name| 2-41 chars, `[a-z0-9_]`. Becomes the function name shown to the model. |
| Description  | One sentence the model uses to decide when to call it.      |
| Endpoint URL | The extension sends `POST` to this URL.                     |
| Headers      | Optional JSON object. Merged into the request headers.      |
| Parameters   | A JSON Schema describing the tool's arguments.              |
| Enabled      | Disable to keep the tool registered but hidden from the model. |

When the agent calls your tool, the extension issues:

```http
POST <endpoint>
Content-Type: application/json
<your custom headers>

{
  "tool": "<function name>",
  "arguments": { ...validated by your JSON schema... }
}
```

Reply with any JSON. The whole response body is forwarded back to the model as
the tool result. Non-2xx responses are surfaced as `{"ok":false,"error":"HTTP <code>","body":<json>}`.

Requests time out after 30 s.

### Example: arXiv search server

```python
from flask import Flask, request, jsonify
import urllib.parse, urllib.request, xml.etree.ElementTree as ET

app = Flask(__name__)

@app.post("/agent-tool")
def tool():
    body = request.get_json() or {}
    args = body.get("arguments", {})
    q = urllib.parse.quote(args.get("query", ""))
    url = f"https://export.arxiv.org/api/query?search_query={q}&max_results=5"
    feed = ET.fromstring(urllib.request.urlopen(url).read())
    ns = {"a": "http://www.w3.org/2005/Atom"}
    return jsonify({"ok": True, "results": [
        {"title": e.findtext("a:title", "", ns).strip(),
         "id": e.findtext("a:id", "", ns)}
        for e in feed.findall("a:entry", ns)
    ]})

app.run(port=8000)
```

Register it as `search_arxiv` with parameters
`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`
and endpoint `http://localhost:8000/agent-tool`.

---

## MCP servers

Wire up [Model Context Protocol](https://modelcontextprotocol.io) servers
speaking **Streamable HTTP**. Defined under **Settings → MCP**:

| Field        | Notes                                                  |
| ------------ | ------------------------------------------------------ |
| Name         | Used as the namespace prefix for tools.                |
| Endpoint URL | The Streamable-HTTP MCP endpoint, e.g. `https://example.com/mcp`. |
| Headers      | Optional JSON object (e.g. `Authorization`).           |
| Enabled      | Disable to keep the config but skip discovery on send. |

Click **Probe tools** to verify connectivity and preview the tools the server
exposes.

Discovered tools are surfaced to the model with namespaced names like
`mcp__<server>__<tool>`. The server's `tools/list` JSON Schema is forwarded to
the model verbatim. Tool call results render plain-text content if the server
returns it, otherwise the raw JSON-RPC payload.

The MCP client supports both `application/json` and `text/event-stream`
responses, so it works with most modern Streamable-HTTP servers.

---

## Sessions

Each typst.app project has its own list of chat sessions, accessible via the
dropdown in the top-left of the side panel.

- **Rename** a session by hovering over it in the list and clicking the pencil,
  or by double-clicking the name. Press **Enter** to commit or **Escape** to
  cancel.
- **Delete** a session via the `×` button.
- **New chat** creates a fresh session for the current project.

### Manage all sessions

Open **Manage all chats…** from the bottom of the session dropdown (or
**Settings → Sessions**) to see every chat you've ever had, grouped by
typst.app project. From the manage pane you can:

- Filter by name, project id, or message content.
- Rename or delete any single chat, even for a project you don't currently
  have open.
- **Delete all** chats for a project in one click.
- **Open project** launches that typst.app project in a new tab.
- **Export** every session as a JSON file, and **Import** them back in — handy
  for backups or moving to another browser profile.

Sessions that belong to the project you have open expose a small switch-to
arrow so you can jump directly into them without leaving the side panel.

### Auto-naming

Under **Settings → General → Auto-name sessions** you can pick any configured
model to generate a short title for a new session automatically. The title is
computed from the first user message plus the first assistant reply, right
after the first agent turn finishes streaming.

- Only sessions still named `New chat` get auto-named. As soon as you rename
  a session manually, auto-naming leaves it alone.
- Choose `Off` to disable the feature entirely.
- The named request is a one-shot, non-streaming call capped at 24 tokens — you
  can safely pick a small/cheap model (e.g. a mini or a local one) here.

## Settings → General

| Setting              | Effect                                                      |
| -------------------- | ----------------------------------------------------------- |
| Appearance           | Light / dark theme.                                         |
| History cap          | Older messages are summarised away once history grows past this many entries. |
| Auto-name sessions   | Optional model used to generate titles for new chats; see **Sessions → Auto-naming**. |
| System prompt        | Replaces the built-in default. Leave empty to use the default. |

---

## Project layout

```
typst-side-agent/
├── manifest.json
├── package.json
├── README.md
├── scripts/
│   └── check-syntax.mjs        # npm run check (cross-platform node --check)
└── src/
    ├── shared/
    │   └── constants.js          # Storage keys, limits, default system prompt
    ├── background/
    │   ├── service-worker.js     # Tab orchestration + message router
    │   ├── agent.js              # Streaming loop, tool dispatch, MCP discovery
    │   ├── context.js            # System message + history compaction
    │   ├── tools.js              # Built-in / custom / MCP tool specs
    │   ├── mcp.js                # Streamable-HTTP MCP client
    │   └── storage.js            # chrome.storage.local persistence
    ├── content/
    │   ├── isolated.js           # Isolated-world bridge to the page
    │   ├── main.js               # CodeMirror access + tool execution
    │   ├── workspace.js          # Workspace UI heuristics
    │   └── diagnostics.js        # Improve-panel diagnostics extraction
    └── sidepanel/
        ├── index.html
        ├── styles.css            # Light/dark themes (rgb tokens)
        ├── state.js              # Cross-module side-panel state
        ├── chat.js               # Messages + streaming + tool blocks
        ├── settings-panel.js     # Tabs + registries (models, tools, MCP, sessions)
        ├── app.js                # Entry: bootstraps everything
        └── lib/marked.min.js
```

---

## Privacy

- API keys, custom-tool headers, and MCP headers live in
  `chrome.storage.local`. They never leave the browser except to the
  configured model / tool / MCP endpoints.
- The extension never uploads pages or images on its own; it only sends what
  you attach to a turn or what tools explicitly fetch.

---

## Contributing

1. Fork and clone.
2. `npm test` — the suite is dependency-free, runs on Node ≥ 20, and finishes
   in well under a second. CI runs the same command on Node 20 and 22.
3. Load the unpacked extension from your checkout (`chrome://extensions` →
   **Load unpacked**) and iterate.
4. See [`TESTING.md`](./TESTING.md) for the full testing process: static
   checks, unit tests, the manual QA checklist, and the release checklist.

When adding code that touches `chrome.*`, `fetch`, or the DOM, split a pure
helper out so it can be unit-tested. The existing split between `agent.js`
(streaming / dispatch) and `context.js` (pure message shaping) is the model
to follow.

## License

MIT — see [`LICENSE`](./LICENSE).
