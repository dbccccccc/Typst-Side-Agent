# Plan 005: Sanitize model and imported content before rendering

> **Executor instructions**: Execute after plan 001. Model output, imported
> sessions, tool content, and URLs are untrusted. Do not rely on MV3 CSP as an
> HTML sanitizer. Update plan 005 in <code>plans/README.md</code> after all
> checks pass.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- src/sidepanel/chat.js src/sidepanel/app.js src/sidepanel/index.html src/sidepanel/lib src/background/storage.js scripts package.json package-lock.json test README.md PRIVACY.md TESTING.md</code>
> A changed renderer or imported-session shape is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: <code>plans/001-establish-verification-baseline.md</code>
- **Category**: security, dependencies
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The side panel assigns unsanitized Marked output to <code>innerHTML</code> for
both live model output and persisted/imported assistant messages. A hostile
response can spoof privileged UI or trigger remote subresource requests.
Imported message objects are not shape-validated, so an untrusted export file
reaches the same sink.

This plan establishes one safe rendering boundary, a strict link/image policy,
validated imported display records, and reproducible provenance for vendored
renderer libraries.

## Current state

- <code>src/sidepanel/chat.js:13-18</code>:

  ~~~js
  export function renderMarkdown(text) {
    try {
      return window.marked.parse(text);
    } catch {
      return escapeHtml(text);
    }
  }
  ~~~

- Persisted assistant content is assigned at
  <code>src/sidepanel/chat.js:193</code>.
- Streamed content is assigned at <code>src/sidepanel/chat.js:398</code>.
- <code>src/background/storage.js:135-152</code> accepts imported message
  arrays without validating message or segment fields.
- <code>src/sidepanel/index.html:227</code> loads
  <code>lib/marked.min.js</code>.
- The vendored header identifies Marked 12.0.0, but
  <code>package-lock.json</code> has no third-party dependency record and
  syntax tests exclude minified/vendor files.
- Static HTML/SVG assignments elsewhere are packaged constants. Do not replace
  them unless they share the untrusted renderer path.

## Rendering policy

The safe renderer must:

- escape or discard raw HTML from Markdown input;
- allow only the formatting tags needed by existing chat CSS;
- strip event attributes, inline styles, forms, frames, objects, embeds, and
  unknown attributes;
- allow links only for explicitly supported schemes such as HTTPS and mailto;
- add <code>rel="noopener noreferrer"</code> to external links;
- block remotely loaded Markdown images by default. Render their alt text and
  a safe link instead; preview attachments remain rendered through their
  existing data-URL component;
- reject non-HTTPS remote resource URLs rather than rewriting them;
- return plain escaped text on parser or sanitizer failure.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | <code>node --test test/chat-security.test.mjs test/storage.test.mjs</code> | all pass |
| Vendor verification | <code>npm run vendor:verify</code> | committed bundles match pinned packages/checksums |
| Full verification | <code>npm run verify</code> | exit 0 |
| Browser smoke | <code>npm run test:browser</code> | exit 0 with security cases |
| Find unsafe sink | <code>rg -n "innerHTML = renderMarkdown" src/sidepanel</code> | no matches |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>src/sidepanel/chat.js</code>
- <code>src/sidepanel/app.js</code> only for rendering/import error handling
- <code>src/sidepanel/index.html</code>
- <code>src/sidepanel/lib/</code>
- <code>src/sidepanel/lib/README.md</code> or
  <code>THIRD_PARTY_NOTICES.md</code> (create)
- <code>src/background/storage.js</code> for imported message validation only
- <code>scripts/vendor-sidepanel-libs.mjs</code> (create)
- <code>test/chat-security.test.mjs</code> (create)
- <code>test/storage.test.mjs</code>
- <code>test/browser-smoke.test.mjs</code>
- <code>package.json</code>
- <code>package-lock.json</code>
- <code>README.md</code>, <code>PRIVACY.md</code>, and
  <code>TESTING.md</code>

**Out of scope**:

- Storage quotas, retention, and per-session migration; plan 009 owns them.
- Stream batching; plan 011 owns it.
- Sanitizing static, packaged SVG constants.
- Loading a sanitizer or Markdown parser from a CDN.
- Claiming arbitrary JavaScript execution when CSP blocks it; the concrete
  boundary is untrusted DOM and resource loading.

## Git workflow

- Branch: <code>codex/005-sanitize-chat-rendering</code>
- Suggested commits:
  - <code>test: cover hostile chat rendering</code>
  - <code>fix: sanitize model and imported markdown</code>
- Do not push or publish.

## Steps

### Step 1: Add browser-level hostile-content regression tests

Use the plan 001 browser harness to render:

- raw HTML elements not in the allowlist;
- attributes that cause browser actions;
- unsafe and cleartext URL schemes;
- external Markdown images;
- nested/ malformed markup;
- an imported assistant record containing the same categories.

Tests must assert the resulting DOM shape and that the local request recorder
observes no unexpected network request. Describe hostile categories in test
names; do not place reusable attack demonstrations in documentation.

**Verify**: the focused browser security cases fail against the current
renderer before the fix.

### Step 2: Make renderer dependencies reproducible

Add Marked at the currently shipped version first, preserving behavior, and a
reviewed sanitizer as pinned development dependencies. Create
<code>scripts/vendor-sidepanel-libs.mjs</code> to copy deterministic browser
artifacts into <code>src/sidepanel/lib/</code>.

The script must:

- refuse an unexpected package version;
- write or verify recorded SHA-256 checksums;
- preserve license notices;
- avoid minifying project source;
- support <code>vendor:update</code> and read-only
  <code>vendor:verify</code> scripts.

Record package name, version, upstream URL, license, committed artifact, and
update procedure in the vendor notice. An upgrade beyond the currently shipped
Marked major is not part of this security fix unless tests prove it is needed.

**Verify**: delete only generated vendor copies in a disposable working copy,
run the update script, and confirm <code>git diff --exit-code -- src/sidepanel/lib</code>.
Then restore the normal tree and run <code>npm run vendor:verify</code>.

### Step 3: Implement one safe Markdown-to-DOM boundary

Replace the function that returns trusted HTML with a function that produces a
sanitized fragment or sanitized HTML through one reviewed boundary.

Apply the Rendering policy above. Configure Marked to avoid raw HTML before
sanitization, then sanitize as defense in depth. Override link/image rendering
where necessary so network policy is explicit rather than dependent on
sanitizer defaults.

All live and persisted assistant text must call the same function. Parser or
sanitizer failure must render escaped text and record a non-sensitive console
error suitable for extension debugging.

Do not use <code>innerHTML</code> outside this single reviewed boundary. If the
sanitizer returns a fragment, append the fragment directly.

**Verify**: focused DOM tests pass and
<code>rg -n "innerHTML = renderMarkdown" src/sidepanel</code> returns no
matches.

### Step 4: Validate imported display records before storage

Create a pure normalizer for imported session messages:

- allowed roles only;
- string length bounds;
- known segment types only;
- arrays and objects bounded in depth/count;
- discard unknown UI-only fields;
- validate attachment metadata and allow only expected local data-image
  forms;
- return per-record errors without partially trusting nested objects.

Import must report rejected-record counts. It must not silently store an
unbounded or malformed message object. Keep compatibility with valid version-1
exports.

Plan 009 will further summarize and migrate retained payloads; do not implement
quota migration here.

**Verify**: <code>node --test test/storage.test.mjs test/chat-security.test.mjs</code>
passes.

### Step 5: Document rendering and import safety

Update README/privacy/testing to state:

- assistant Markdown is sanitized;
- raw HTML and remote Markdown images are not rendered;
- imported sessions are validated;
- preview attachments remain locally captured data;
- how vendored renderer libraries are updated and verified.

**Verify**: <code>npm run verify</code> and browser smoke pass.

## Test plan

- Pure tests for URL allowlisting and imported-message normalization.
- Browser tests for allowed formatting and blocked hostile categories.
- Assert no remote request from model-generated images or HTML.
- Assert external safe links receive correct <code>rel</code> attributes.
- Assert parser/sanitizer failure falls back to escaped visible text.
- Assert valid version-1 session exports still import.
- Assert invalid imports report counts and never reach storage.

## Done criteria

- [ ] Live and persisted assistant content use one sanitized boundary.
- [ ] Raw HTML, active attributes, forms/frames, and unsafe schemes are
  removed.
- [ ] Model-generated remote images cannot initiate requests.
- [ ] Valid Markdown formatting still renders.
- [ ] Imported message and attachment shapes are bounded and validated.
- [ ] Marked and the sanitizer are pinned, licensed, checksummed, and
  reproducibly vendored.
- [ ] <code>npm run vendor:verify</code> exits 0.
- [ ] Focused tests, <code>npm run verify</code>, and browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 005 is marked DONE.

## STOP conditions

Stop and report if:

- The sanitizer depends on remote code, dynamic evaluation, or unsupported
  Node APIs in the side panel.
- Reproducing the existing Marked bundle changes rendering before policy
  changes are applied.
- Existing valid session exports cannot be distinguished from malformed
  records without a migration decision.
- Blocking remote Markdown images would remove a documented required feature.
- Tests reveal script execution despite expected MV3 CSP; treat that as a new
  security finding rather than expanding this plan silently.

## Maintenance notes

- Any new content source must enter through the same safe rendering boundary.
- Review dependency updates with the hostile-content fixtures.
- Plan 009 may change the persisted message shape; keep the import normalizer
  versioned.
- Plan 011 must preserve final sanitized rendering when it batches updates.
