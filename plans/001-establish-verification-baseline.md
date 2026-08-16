# Plan 001: Establish coverage of dangerous browser boundaries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If any STOP condition occurs, stop and report; do not improvise.
> When done, update plan 001 in <code>plans/README.md</code>.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- package.json package-lock.json scripts test src/background/agent.js src/background/mcp.js src/background/storage.js src/content src/sidepanel .github/workflows/ci.yml TESTING.md</code>
> If an in-scope file changed, compare the Current state excerpts with live
> code. A semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: tests, dx
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The existing 59 tests all pass, but most exercise pure helpers. Provider
streaming, abort behavior, MCP HTTP/SSE handling, session mutations, Chrome
message bridges, and side-panel startup can regress while CI remains green.
This plan creates a reliable baseline before the central routing, tool,
rendering, and storage changes in later plans.

The baseline is intentionally risk-weighted. It does not chase a blanket
coverage percentage for CSS, vendored code, or incidental DOM branches.

## Current state

- <code>package.json:11-15</code> defines only:

  ~~~json
  "test": "node --test test/*.test.mjs",
  "test:watch": "node --test --watch test/*.test.mjs",
  "check": "node scripts/check-syntax.mjs"
  ~~~

- <code>test/agent.test.mjs:1-9</code> imports four pure helpers from the
  733-line agent module; it does not exercise a streamed request or tool loop.
- <code>test/mcp.test.mjs:1-40</code> tests only
  <code>renderMcpContent</code>, not HTTP, SSE, timeouts, or aborts.
- <code>src/background/storage.js:43-155</code> mutates user sessions without
  an automated fake-storage test.
- <code>TESTING.md:68-70</code> explicitly excludes <code>fetch</code>,
  <code>chrome.*</code>, and DOM paths from unit tests.
- <code>.github/workflows/ci.yml:23-24</code> runs only
  <code>npm test</code>.
- Audit coverage at the planned commit was 52.46% of loaded sources;
  <code>agent.js</code> was 22.24%, <code>mcp.js</code> 31.86%, and
  <code>storage.js</code> 43.98%.
- Test style is dependency-light Node ESM using
  <code>node:test</code> and <code>node:assert/strict</code>. Match
  <code>test/agent.test.mjs</code> and <code>test/static.test.mjs</code>.
- Contributor convention from <code>README.md:322-325</code>: isolate pure
  cores from thin <code>chrome.*</code>, <code>fetch</code>, and DOM adapters.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Baseline tests | <code>npm test</code> | 59 pass before changes |
| Syntax | <code>npm run check</code> | exit 0 |
| Coverage report | <code>node --test --experimental-test-coverage test/*.test.mjs</code> | exit 0 and coverage table |
| Full verification after this plan | <code>npm run verify</code> | lint, syntax, unit/integration tests all pass |
| Browser smoke | <code>npm run test:browser</code> | packaged MV3 smoke passes without external credentials |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>package.json</code>
- <code>package-lock.json</code>
- <code>eslint.config.js</code> (create)
- <code>scripts/check-coverage.mjs</code> (create)
- <code>test/helpers/</code> (create)
- <code>test/fixtures/</code> (create)
- <code>test/agent-integration.test.mjs</code> (create)
- <code>test/mcp-transport.test.mjs</code> (create)
- <code>test/storage.test.mjs</code> (create)
- <code>test/browser-smoke.test.mjs</code> (create)
- <code>src/background/agent.js</code>
- <code>src/background/mcp.js</code>
- <code>src/background/storage.js</code>
- <code>src/content/isolated.js</code>
- <code>src/content/main.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/index.html</code>
- <code>.github/workflows/ci.yml</code>
- <code>TESTING.md</code>

**Out of scope**:

- Fixing the run-routing, tool-validation, rendering, MCP-protocol, or storage
  defects covered by later plans.
- Authenticated typst.app automation or real provider credentials.
- Replacing native ES modules, adding an application framework, or converting
  production code to TypeScript.
- Testing vendored minified code directly.

## Git workflow

- Branch: <code>codex/001-verification-baseline</code>
- Use logical commits with the repository's observed style, for example
  <code>test: cover background boundaries</code> and
  <code>ci: run verification suite</code>.
- Do not push or open a pull request unless instructed.

## Steps

### Step 1: Add semantic linting and one verification command

Add a flat ESLint configuration for:

- browser/WebExtension globals under <code>src/</code>,
- Node globals under <code>scripts/</code> and <code>test/</code>,
- ESM syntax,
- correctness-oriented rules first: undefined identifiers, duplicate cases,
  unreachable code, accidental globals, invalid regular expressions, and
  ignored promises where ESLint can detect them.

Do not introduce style churn across all source files. Fix only genuine errors
or narrowly suppress a rule with a comment that explains the browser
constraint.

Add scripts:

- <code>lint</code>
- <code>coverage</code>
- <code>test:browser</code>
- <code>verify</code>, ordered as lint, syntax check, tests, then the
  risk-weighted coverage gate.

**Verify**: <code>npm run lint</code> and <code>npm run check</code> both exit
0.

### Step 2: Introduce injectable network and Chrome adapters without behavior changes

Extract only the minimum seams required to test:

- provider <code>fetch</code> and streamed response reading in
  <code>agent.js</code>,
- MCP <code>fetch</code>, timers, and abort signals in <code>mcp.js</code>,
- <code>chrome.storage.local</code> access in <code>storage.js</code>,
- tab/runtime messaging used by one complete request path.

Production defaults must remain the native global APIs. Tests must pass fake
adapters explicitly; do not install globals that leak between test files.

Create reusable fakes under <code>test/helpers/</code>:

- deterministic <code>ReadableStream</code> chunk source,
- deferred promise/timer control,
- fake <code>chrome.storage.local</code> with optional interleaving hooks,
- fake tabs/runtime messenger that records target tab IDs and messages.

**Verify**: <code>npm test</code> exits 0 and the original 59 tests still pass
unchanged.

### Step 3: Characterize agent, MCP, and storage boundaries

Add focused tests covering current behavior:

- provider SSE split across arbitrary byte boundaries;
- content, reasoning, and tool-call accumulation;
- malformed and incomplete SSE records;
- HTTP failure and abort before headers and during body reads;
- custom-tool and MCP timeout paths;
- MCP JSON and SSE responses, including CRLF and multiline-event fixtures
  that document the current defect as skipped or expected-failure tests until
  plan 008;
- session create, update, delete, project delete, list ordering, and import;
- deliberately interleaved storage updates that document the current lost
  update defect until plan 009.

Tests that encode a known defect must be named clearly and marked TODO/skip,
not asserted as desired behavior.

**Verify**:
<code>node --test test/agent-integration.test.mjs test/mcp-transport.test.mjs test/storage.test.mjs</code>
exits 0 with only explicitly documented known-defect skips.

### Step 4: Add a packaged MV3 smoke test with local fixtures

Use Playwright with a persistent Chromium context and the unpacked extension.
Intercept a request to a typst.app-shaped HTTPS URL and serve a local fixture
that contains only the editor/preview DOM needed by the extension. Do not use
an authenticated account.

The smoke must prove:

1. The extension service worker starts.
2. The side-panel document loads without uncaught exceptions.
3. The content scripts inject on the typst.app-shaped fixture.
4. One probe/context request traverses side panel or extension page → service
   worker → isolated world → main world and returns.
5. A local mock OpenAI-compatible endpoint can return one streamed text
   response without a real API key.

Keep fixture selectors intentionally minimal; the real typst.app heuristic
check remains in manual release QA.

**Verify**: <code>npm run test:browser</code> exits 0 twice consecutively on a
clean checkout.

### Step 5: Add risk-weighted coverage enforcement and wire CI

Create a coverage gate that fails when the critical background modules regress
below the post-test baseline. The gate must:

- include <code>agent.js</code>, <code>mcp.js</code>, and
  <code>storage.js</code> explicitly;
- record the new measured module floors in <code>TESTING.md</code>;
- avoid claiming coverage for DOM modules solely because they were not loaded;
- allow floors to increase without changing production code.

Change CI to run <code>npm ci</code>, <code>npm run verify</code>, and
<code>npm run test:browser</code>. Cache only package-manager data, never the
extension profile or generated browser state.

**Verify**: <code>npm run verify</code> and
<code>npm run test:browser</code> both exit 0.

## Test plan

- Use <code>test/agent.test.mjs</code> as the assertion/naming model.
- Use <code>test/static.test.mjs</code> as the async filesystem/process model.
- Every fake must reset state in <code>afterEach</code> or be constructed per
  test.
- Include happy path, HTTP failure, timeout, cancellation, malformed input,
  partial stream, and concurrent mutation cases.
- No test may contact typst.app, a model provider, a custom tool, or an MCP
  server on the public network.

## Done criteria

- [ ] <code>npm run lint</code> exits 0.
- [ ] <code>npm run check</code> exits 0.
- [ ] <code>npm test</code> exits 0 with all original and new tests passing.
- [ ] <code>npm run coverage</code> exits 0 and enforces named floors for
  agent, MCP, and storage.
- [ ] <code>npm run test:browser</code> exits 0 twice consecutively.
- [ ] CI invokes both <code>npm run verify</code> and the browser smoke.
- [ ] No browser smoke requires credentials, an installed user profile, or
  public-network access.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 001 is marked DONE in <code>plans/README.md</code>.

## STOP conditions

Stop and report if:

- Test seams require changing user-visible behavior rather than dependency
  injection.
- The chosen browser runner cannot load MV3 service workers in the available
  CI environment after two documented attempts.
- The local typst.app-shaped fixture cannot be isolated from public-network
  access.
- Lint adoption would require a repository-wide formatting rewrite.
- Any test output includes an API key, authorization header, or imported
  session content from a real profile.

## Maintenance notes

- Later plans should extend these fakes instead of creating incompatible
  per-plan mocks.
- Raise coverage floors only when meaningful behavior is covered.
- Review browser-runner upgrades for changes to extension loading and
  service-worker lifetime.
- The authenticated Edge/Chrome checklist remains a release gate even after
  this smoke test exists.
