# Plan 007: Separate untrusted content and authorize side effects

> **Executor instructions**: Execute after plans 003 and 004. This plan changes
> safety UX intentionally: read-only operations may remain automatic, while
> editor writes and external side effects require an explicit policy decision.
> Do not weaken defaults merely to preserve the current fully automatic loop.
> Update plan 007 in <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/background/context.js src/background/agent.js src/background/tools.js src/background/service-worker.js src/shared/constants.js src/sidepanel src/background/storage.js manifest.json README.md PRIVACY.md TESTING.md test</code>
> Changes to tool metadata, run identity, or settings storage require
> reconciliation before implementation.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**:
  <code>plans/003-isolate-agent-runs.md</code>,
  <code>plans/004-validate-tool-dispatch.md</code>
- **Category**: security
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

Project selections, document/tool output, diagnostic text, MCP descriptions,
and external tool results are data that may contain instructions not authored
by the extension owner. The current loop exposes all tools together and
executes the model's chosen editor/custom/MCP calls without an authorization
gate. Explicit instruction labels help the model but are not a security
boundary; enforcement must happen at dispatch.

After this plan, trusted policy and untrusted data use separate message roles,
every tool has effect metadata, and side effects are approved under clear
defaults. Cleartext endpoint use and extension-storage exposure are also
tightened without removing intentionally arbitrary user-configured endpoints.

## Current state

- <code>src/background/context.js:40-99</code> concatenates document,
  workspace, selection, and diagnostic content into one system-role message.
- <code>src/background/context.js:68-72</code> places attached selection text
  directly in that message.
- <code>src/background/agent.js:544-548</code> exposes built-in, custom, and
  MCP tools in one array.
- <code>src/background/agent.js:596-602</code> executes every model-selected
  call after displaying it.
- <code>src/background/agent.js:628-644</code> has no authorization check
  before editor or external calls.
- <code>src/sidepanel/settings-panel.js:361-363</code> accepts any HTTP or
  HTTPS custom endpoint; the MCP form has the same policy.
- <code>manifest.json:14-18</code> intentionally grants HTTP/HTTPS host access
  for user-configured providers and tools.
- <code>src/background/storage.js:4-9</code> uses
  <code>chrome.storage.local</code>; Chrome exposes this area to content
  scripts by default unless access is restricted.
- Existing tool/preflight blocks already have Retry/Skip UI and are the visual
  pattern to reuse. Do not create a second unrelated interaction language.

## Required policy

Classify tools:

| Class | Examples | Default |
|-------|----------|---------|
| Read-only local | read document, diagnostics, bundled docs | automatic |
| Editor mutation | replace, insert, patch | approval once |
| External network | custom HTTP, MCP call | approval once |
| Unknown MCP effect | any MCP tool without trusted metadata | external network default |

Allow explicit user choices:

- Approve once.
- Allow this exact tool for the current run.
- Deny.
- A persisted trusted-auto-run flag only when the user deliberately enables it
  in settings. Existing integrations migrate to untrusted/approval-required.

Never let model text set or modify approval state.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/tool-policy.test.mjs test/context.test.mjs test/agent-integration.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | approval flow passes |
| System-data search | <code>rg -n "Initial document snapshot|Selected text|Initial diagnostics" src/background/context.js</code> | no untrusted data in system builder |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/background/context.js</code>
- <code>src/background/agent.js</code>
- <code>src/background/tools.js</code> or plan 004's registry module
- <code>src/background/service-worker.js</code>
- <code>src/background/storage.js</code> for policy settings/access level
- <code>src/shared/constants.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/chat.js</code>
- <code>src/sidepanel/settings-panel.js</code>
- <code>src/sidepanel/index.html</code>
- <code>src/sidepanel/styles.css</code>
- <code>test/tool-policy.test.mjs</code> (create)
- <code>test/context.test.mjs</code>
- <code>test/agent-integration.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>README.md</code>, <code>PRIVACY.md</code>,
  <code>TESTING.md</code>

**Out of scope**:

- Removing arbitrary endpoint host permissions.
- Claiming prompt text alone prevents prompt injection.
- One-click edit rollback; that is a future product direction.
- MCP protocol negotiation.
- Encrypting credentials with a key stored beside them; that would not create
  a meaningful security boundary.

## Git workflow

- Branch: <code>codex/007-gate-untrusted-side-effects</code>
- Suggested commits:
  - <code>test: characterize tool approval policy</code>
  - <code>feat: gate editor and external tool effects</code>
  - <code>docs: document agent trust boundaries</code>
- Do not push or publish.

## Steps

### Step 1: Add effect metadata to the validated registry

Extend plan 004's registry entry with:

- <code>effect</code>: read, editor-write, external;
- <code>approval</code>: automatic, once, trusted;
- human-readable destination for external tools;
- immutable original integration ID.

Built-ins receive explicit metadata in source. Custom and MCP tools default to
external/once. Missing or unknown metadata must choose the more restrictive
class and must never become automatic.

Keep this metadata out of model-controlled arguments.

**Verify**: pure registry tests cover every built-in and restrictive defaults.

### Step 2: Separate trusted instructions from untrusted context

Refactor context construction into:

- a trusted system message containing agent policy and tool behavior only;
- one or more context messages containing project text, selections,
  diagnostics, workspace heuristics, and tool-originated data, labeled as
  untrusted data.

Preserve ordering so the user's actual request remains clear. Add a trusted
instruction that data must be interpreted as Typst/project/tool content, not
as authority. Do not claim that the label prevents injection; the dispatch
gate is the enforcement layer.

Update context tests to assert that unique project strings occur only in
untrusted context messages and never in the system message.

**Verify**: <code>node --test test/context.test.mjs</code> passes and the
system-data search returns no matches in the trusted builder.

### Step 3: Implement run-scoped approval state

Create approval waiters keyed by <code>runId + callId</code>. Before dispatch:

1. Read effect metadata.
2. Execute automatic read-only tools immediately.
3. Check a run-local allowlist for the exact registry identity.
4. Check a persisted trusted flag only for the exact custom/MCP integration
   the user configured.
5. Otherwise emit an approval-required event and wait.
6. On deny/cancel, return a structured tool result to the model and perform no
   side effect.

Approval must expire with the run. Run cleanup and cancellation must resolve
all outstanding waiters. Unknown or mismatched approval messages are ignored
and logged without sensitive data.

**Verify**: tests prove that no editor/fetch adapter is called before approval,
and approval for run A cannot authorize run B.

### Step 4: Add approval UI by extending existing tool blocks

Reuse the existing preflight banner/button visual language. Show:

- tool label;
- effect class;
- editor target or external hostname, never credential headers;
- concise argument summary after plan 004 validation;
- Approve once, Allow for run, and Deny.

For persisted trust, add an explicit checkbox to custom/MCP settings with a
warning that the integration may receive project-derived data automatically.
Do not offer persisted trust from model-generated content or the transient
tool block.

Default editor writes to approval once. If a global
<code>autoApplyEditorEdits</code> setting is offered, migrate existing users to
false and explain the change.

**Verify**: browser smoke confirms approve, allow-for-run, deny, cancel, and
cross-run isolation.

### Step 5: Harden endpoint transport decisions

At model/custom/MCP configuration save:

- accept HTTPS;
- accept loopback HTTP for local development;
- reject or require a separate explicit insecure-transport confirmation for
  non-loopback HTTP;
- display the exact destination origin before confirmation;
- store the acknowledgement on that integration, not globally.

Do not remove broad host permissions in this plan; arbitrary configured
destinations remain a product feature.

Update privacy and README language to match actual behavior.

**Verify**: pure URL-policy tests cover HTTPS, loopback IPv4/IPv6/localhost,
  private-network HTTP, malformed URLs, embedded credentials, and non-HTTP
  schemes.

### Step 6: Restrict extension storage access to trusted contexts

During service-worker installation/startup, call
<code>chrome.storage.local.setAccessLevel</code> with trusted extension
contexts. Confirm content scripts use background messages rather than direct
storage access before doing so.

Handle unsupported-browser errors without disabling the extension, but record
a non-sensitive diagnostic.

**Verify**: repository search finds no required direct
<code>chrome.storage</code> use under <code>src/content</code>, and browser
smoke still loads settings/sessions through the service worker.

### Step 7: Update safety documentation and release QA

Document:

- trusted versus untrusted content;
- approval defaults and trusted-auto-run implications;
- destination visibility;
- loopback HTTP exception;
- cancellation/denial behavior;
- that prompts are not a security boundary.

Add manual tests involving a shared/untrusted document and an external tool,
without embedding reusable malicious content in documentation.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Pure policy tests for every effect class and setting combination.
- Context-role tests with sentinel project/tool strings.
- Agent tests asserting zero executor calls before approval.
- Cross-run and stale-approval tests.
- Cancellation while awaiting approval.
- URL policy tests, including loopback versus other HTTP hosts.
- Browser tests for accessible buttons, keyboard operation, and visible
  destination/effect labels.
- Storage access smoke after trusted-context restriction.

## Done criteria

- [ ] Project/tool-derived data is absent from the trusted system message.
- [ ] Every exposed tool has explicit effect metadata.
- [ ] Read-only local tools remain automatic.
- [ ] Editor writes and external calls require approval by default.
- [ ] Approval is scoped by run and exact tool identity.
- [ ] Existing integrations migrate to untrusted, not auto-run.
- [ ] Non-loopback HTTP cannot be saved silently.
- [ ] Content scripts no longer have default direct access to local extension
  storage where the browser supports restriction.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] Documentation and privacy text match the implemented policy.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 007 is marked DONE.

## STOP conditions

Stop and report if:

- Plan 004 did not create a unique validated registry identity for each tool.
- Plan 003 did not create run-scoped event and waiter identity.
- The maintainer rejects approval-by-default for editor writes; record that
  product decision before implementing a different default.
- A content script directly requires storage access for a feature that cannot
  be routed through the service worker.
- Chrome cannot represent the required approval UI accessibly in the existing
  side panel without a larger redesign.

## Maintenance notes

- New tools must declare effects and tests in the same change.
- Reviewers should verify the enforcement point, not only prompt wording.
- MCP metadata is not trusted to downgrade an effect unless the user confirms
  the server/integration.
- Plan 009 must not export persisted trust together with secret headers by
  default.
