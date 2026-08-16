# Plan 008: Implement a declared, protocol-complete MCP transport

> **Executor instructions**: Execute after plans 004 and 006. Implement only
> protocol versions explicitly declared and fixture-tested. Do not preserve the
> current direct-RPC shortcut under a compatibility label. Update plan 008 in
> <code>plans/README.md</code> after all gates pass.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/mcp.js src/background/agent.js src/background/tools.js src/background/storage.js src/sidepanel/settings-panel.js src/sidepanel/index.html README.md TESTING.md test package.json package-lock.json</code>
> Changed MCP settings, tool schemas, or cancellation APIs are a STOP condition
> until reconciled.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**:
  <code>plans/004-validate-tool-dispatch.md</code>,
  <code>plans/006-propagate-cancellation.md</code>
- **Category**: bug, migration
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The current client posts <code>tools/list</code> and
<code>tools/call</code> directly with generic JSON/SSE headers. It neither
declares a protocol version nor implements a version-specific lifecycle.
Its SSE parser also fails valid CRLF-delimited streams and omits pagination.
Standards-compliant servers can therefore reject calls or appear to connect
while exposing incomplete tools.

After this plan, each configured server has a declared/negotiated version,
transport behavior is driven by that version, SSE framing is correct,
pagination and cache hints are honored, and unsupported servers fail with
actionable diagnostics.

## Current state

- <code>src/background/mcp.js:13-23</code> sends only Content-Type, Accept,
  and user headers.
- <code>src/background/mcp.js:41-47</code> splits SSE only on LF-LF:

  ~~~js
  const events = buffer.split(/\n\n/);
  buffer = events.pop() || '';
  ~~~

- <code>src/background/mcp.js:66-92</code> sends direct JSON-RPC
  <code>tools/list</code> and <code>tools/call</code> requests.
- <code>src/background/agent.js:309-319</code> discovers every enabled server
  on every user message and waits for all of them.
- <code>src/background/agent.js:293-297</code> retains raw MCP results as well
  as rendered content; plan 009 will address persistence.
- <code>test/mcp.test.mjs</code> covers result rendering only. Plan 001 should
  have added transport fixtures and plan 006 should have added parent-signal
  cancellation.
- <code>README.md:193-214</code> claims compatibility with most modern
  Streamable-HTTP servers.
- The current official release at planning time is MCP
  <code>2026-07-28</code>. Its primary documentation is:
  <https://blog.modelcontextprotocol.io/posts/2026-07-28/> and the linked
  specification. It uses self-describing request metadata and HTTP routing
  headers. Treat the specification, not the audit summary, as authoritative.

## Version support decision

Implement these explicit modes:

- <code>Auto</code>: attempt the current supported specification first and
  use only a deliberately implemented legacy mode when the server returns an
  unambiguous version/lifecycle incompatibility.
- <code>2026-07-28</code>: current stateless request contract.
- One legacy Streamable-HTTP version only if existing repository fixtures or
  documented users require it. The legacy implementation must include its
  full initialization/session lifecycle; a direct-call shortcut is not a
  legacy protocol.

If the required legacy version cannot be established from evidence, ship
current-only with a clear settings error rather than guessing.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/mcp-transport.test.mjs test/mcp.test.mjs test/tool-validation.test.mjs test/cancellation.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | mock MCP discovery/call passes |
| Dependency audit | <code>npm audit --omit=dev</code> | no reachable production advisory |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/background/mcp.js</code>
- <code>src/background/agent.js</code>
- <code>src/background/tools.js</code> or plan 004 registry integration
- <code>src/background/storage.js</code> for server version/cache settings
- <code>src/sidepanel/settings-panel.js</code>
- <code>src/sidepanel/index.html</code>
- <code>test/mcp-transport.test.mjs</code>
- <code>test/mcp.test.mjs</code>
- <code>test/tool-validation.test.mjs</code>
- <code>test/cancellation.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>README.md</code>
- <code>TESTING.md</code>
- <code>package.json</code>
- <code>package-lock.json</code>

**Out of scope**:

- Supporting every historical MCP version.
- OAuth/DCR/CIMD UI beyond existing user-supplied headers unless required for
  the selected transport.
- MCP Apps, tasks, prompts, resources, sampling, elicitation, or server-initiated
  requests.
- Persisting raw MCP results; plan 009 owns retention.
- Hand-writing a partial protocol while claiming SDK-equivalent coverage.

## Git workflow

- Branch: <code>codex/008-complete-mcp-transport</code>
- Suggested commits:
  - <code>test: add MCP protocol fixtures</code>
  - <code>fix: implement versioned MCP transport</code>
  - <code>docs: declare MCP compatibility</code>
- Do not push or publish.

## Steps

### Step 1: Freeze authoritative protocol fixtures

Read the official specification linked above and create compact fixtures for
the supported operations:

- request headers and body metadata for tool listing and calling;
- successful JSON response;
- SSE response with LF and CRLF separators;
- multiline SSE data and arbitrary byte splits;
- final event without a trailing blank line;
- JSON-RPC error;
- HTTP error;
- pagination cursor;
- cache hints;
- version/lifecycle incompatibility;
- cancellation during stream.

Each fixture must cite the specification section/date in a test comment.
Fixtures contain no real endpoint, credential, or user document.

**Verify**: fixture files parse and test names enumerate every case above.

### Step 2: Decide SDK versus internal transport with an explicit gate

Prefer the current official Tier-1 TypeScript SDK if it can be deterministically
bundled for a Chrome MV3 service worker without Node polyfills, remote code, or
an unreasonable archive increase.

Perform a small proof:

- bundle only the client and Streamable HTTP transport used here;
- run it in the packaged service worker smoke;
- record minified/uncompressed archive impact.

Accept the SDK path only if the added packaged size is at most 500 KiB and the
browser smoke has no unsupported Node global. Otherwise retain a small
internal transport, but implement every selected-version requirement covered
by the fixtures. Do not mix partial SDK and partial custom lifecycle state.

**Verify**: document the decision and evidence in an MCP module comment or
architecture doc. If neither path satisfies the gate, STOP.

### Step 3: Implement correct request metadata, headers, and lifecycle

For current mode:

- send the exact version header required by the selected specification;
- send required method/name routing headers;
- include required client identity/capability metadata in the body;
- preserve user headers without allowing them to override protocol-critical
  headers silently;
- validate response IDs and protocol errors.

For any supported legacy mode:

- implement initialization before operational requests;
- send the initialized notification when required;
- retain and send the server session identifier;
- terminate/expire session state as the selected specification requires;
- keep state isolated per configured server.

Do not infer success solely from HTTP 200.

**Verify**: header/body/lifecycle fixture tests pass exactly.

### Step 4: Replace the SSE parser with a framing-correct parser

The parser must:

- accept CRLF and LF event separators;
- accumulate arbitrary byte chunks with streaming UTF-8 decode;
- combine multiple data lines;
- ignore comments and unsupported fields safely;
- process the final event at EOF;
- match the JSON-RPC request ID;
- enforce event/response byte limits;
- cancel the reader and remove listeners on match, error, timeout, or parent
  cancellation.

Malformed unrelated events may be skipped up to a bounded error count.
Malformed matching responses must return an explicit error rather than
timing out ambiguously.

**Verify**: every framing fixture and cancellation test passes.

### Step 5: Implement pagination and discovery caching

Follow <code>nextCursor</code> until exhausted, with page/count/byte limits.
Reject duplicate tool identities after plan 004 normalization.

Cache a discovered toolset by:

- immutable server ID;
- URL and non-secret configuration digest;
- selected protocol version;
- server-provided TTL/cache scope where available.

Invalidate on server edit, enable/disable, version change, manual probe, or
authentication failure. A stale-while-refresh path may show last-known tools,
but must label them stale and must not conceal a removed tool indefinitely.

Use a shorter discovery deadline than a tool-call deadline. One failed server
must not block healthy servers, and the UI must show each server's error.

**Verify**: pagination, cache hit, invalidation, TTL expiry, and slow-server
tests pass.

### Step 6: Expose version and diagnostic state in settings

Add protocol mode/version to each MCP record. Existing records migrate to
Auto. Probe results must show:

- selected/negotiated version;
- tool count;
- cache status/expiry;
- concise failure stage;
- no authorization header values.

Use plan 004 validation before exposing discovered tools and plan 006 signals
for probe/discovery/call cancellation.

**Verify**: browser smoke configures a mock server, probes it, calls one tool,
and displays the declared version.

### Step 7: Correct compatibility documentation

Replace broad “most modern servers” language with the exact supported
version(s), modes, operations, authentication mechanism, size limits, and
unsupported features. Add release QA for JSON, LF-SSE, CRLF-SSE, pagination,
cancel, and version errors.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Fixture tests for every header/body/framing/lifecycle requirement.
- Pagination limit and duplicate-tool tests.
- Discovery cache hit, invalidation, expiry, and stale behavior.
- Parent cancel and timeout cleanup.
- One slow/broken server alongside one healthy server.
- Manual/user-header conflict with protocol-critical header.
- Browser mock for probe and call with no external network.

## Done criteria

- [ ] Settings and README declare exact supported protocol version(s).
- [ ] Current-mode requests match authoritative header and metadata fixtures.
- [ ] Any legacy mode implements its full lifecycle.
- [ ] LF, CRLF, multiline, partial, and EOF SSE fixtures pass.
- [ ] Pagination returns the full bounded tool list.
- [ ] Discovery is cached and invalidated predictably.
- [ ] Parent cancellation aborts discovery and tool calls.
- [ ] Invalid/colliding MCP schemas are not exposed.
- [ ] Focused tests, <code>npm run verify</code>, browser smoke, and dependency
  audit pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 008 is marked DONE.

## STOP conditions

Stop and report if:

- The official current specification contradicts a requirement stated in this
  plan; follow the specification only after the plan is reconciled.
- The official SDK requires Node polyfills/remote code or exceeds the size
  gate, and an internal implementation cannot be proven against fixtures.
- Existing users require an unidentified legacy protocol version.
- Authentication requires a new OAuth product flow rather than existing
  user-supplied headers.
- A server requires an unsupported MCP capability outside tools list/call.

## Maintenance notes

- Update protocol fixtures before changing supported MCP versions.
- Cache keys must never contain raw authorization header values.
- Review server-provided cache hints and metadata as untrusted.
- Re-run packaged-size and browser-service-worker checks on SDK upgrades.
- Plan 013 must package any newly vendored MCP artifact deterministically.
