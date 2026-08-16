# Plan 013: Unify packaging, version gates, legacy cleanup, and release docs

> **Executor instructions**: Execute after plans 001, 002, 004, 005, and 007.
> Produce one deterministic archive command used locally, in CI, and in the
> Chrome release workflow. Preserve read-only display compatibility for valid
> historical sessions while removing impossible current producers and stale
> instructions. Update plan 013 in <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- package.json package-lock.json manifest.json scripts test .github/workflows README.md PRIVACY.md TESTING.md src/background/context.js src/background/tools.js src/shared/constants.js src/sidepanel/app.js src/sidepanel/chat.js src/sidepanel/index.html</code>
> Changed package contents, versioning, context producers, or approval docs are
> a STOP condition until reconciled.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**:
  <code>plans/001-establish-verification-baseline.md</code>,
  <code>plans/002-harden-release-actions.md</code>,
  <code>plans/004-validate-tool-dispatch.md</code>,
  <code>plans/005-sanitize-chat-rendering.md</code>,
  <code>plans/007-gate-untrusted-side-effects.md</code>
- **Category**: dx, docs, tech-debt
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

CI, release automation, and TESTING each duplicate a handwritten ZIP allowlist.
The archive includes README but omits files README links, including the privacy
policy. Release correctness also depends on manually keeping package,
manifest, and tag versions equal.

Manual QA still asks for removed Full document and Diagnostics attachment menu
items, while model-facing descriptions reference the same nonexistent path.
Unreachable attachment branches preserve a second stale context design. This
plan makes the artifact reproducible and the shipped/documented behavior
consistent.

## Current state

- <code>.github/workflows/ci.yml:32-35</code> and
  <code>.github/workflows/release-chrome.yml:25-28</code> duplicate:

  ~~~sh
  zip -r typst-side-agent.zip manifest.json src docs icons README.md LICENSE
  ~~~

- The archive omits <code>PRIVACY.md</code> even though
  <code>README.md:306-308</code> links it. README also links
  <code>TESTING.md</code>.
- <code>manifest.json:4</code> and <code>package.json:3</code> both contain
  version 1.0.1, but tests check only semver shape.
- <code>TESTING.md:136-140</code> requires Full document and Diagnostics
  attachment menu entries.
- <code>src/sidepanel/index.html:202-214</code> currently exposes only
  selection, preview screenshot, and opened image.
- <code>src/background/tools.js:39</code> and
  <code>src/shared/constants.js:79</code> tell the model diagnostics are the
  same as Add → Diagnostics.
- <code>src/background/context.js:40-88</code> retains initial document and
  diagnostics attachment branches that the current producer does not create.
- <code>src/sidepanel/chat.js:81-93</code> renders legacy document/diagnostic
  attachment pills. Valid old imports may still require display-only
  compatibility.
- Plan 002 pins workflow actions; preserve those immutable references and
  permissions.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build archive | <code>npm run package</code> | creates deterministic typst-side-agent.zip |
| Verify archive | <code>npm run package:check</code> | exit 0, contents/version valid |
| Focused tests | <code>node --test test/package.test.mjs test/static.test.mjs</code> | all pass |
| Full verification | <code>npm run verify</code> | exit 0 |
| Stale-label search | <code>rg -n "Add → (Full document|Diagnostics)|Initial document snapshot|Initial diagnostics" src README.md TESTING.md</code> | no current-feature claims |
| Patch hygiene | <code>git diff --check</code> | no output |

## Scope

**In scope**:

- <code>package.json</code>
- <code>package-lock.json</code>
- <code>manifest.json</code>
- <code>scripts/package-extension.mjs</code> (create)
- <code>scripts/check-package.mjs</code> (create)
- <code>test/package.test.mjs</code> (create)
- <code>test/static.test.mjs</code>
- <code>.github/workflows/ci.yml</code>
- <code>.github/workflows/release-chrome.yml</code>
- <code>README.md</code>
- <code>PRIVACY.md</code>
- <code>TESTING.md</code>
- <code>src/background/context.js</code>
- <code>src/background/tools.js</code>
- <code>src/shared/constants.js</code>
- <code>src/sidepanel/app.js</code>
- <code>src/sidepanel/chat.js</code>
- <code>src/sidepanel/index.html</code>

**Out of scope**:

- Publishing a release or uploading to Chrome Web Store.
- Changing workflow action pins/permissions from plan 002.
- Restoring removed attachment menu items.
- Removing valid legacy-session display without a migration.
- Packaging tests, plans, git metadata, developer profiles, credentials, or
  local logs.
- Building/minifying production JavaScript.

## Git workflow

- Branch: <code>codex/013-unify-packaging-and-docs</code>
- Suggested commits:
  - <code>build: centralize extension packaging</code>
  - <code>test: verify artifact contents and versions</code>
  - <code>docs: align context and release guidance</code>
- Do not push, tag, release, or publish.

## Canonical archive contents

The archive root must contain:

- <code>manifest.json</code>
- <code>src/</code>
- <code>docs/</code>
- <code>icons/</code>
- <code>README.md</code>
- <code>PRIVACY.md</code>
- <code>TESTING.md</code>
- <code>LICENSE</code>

It must not contain:

- <code>.git/</code>, <code>.github/</code>, editor settings, or hidden
  metadata;
- <code>node_modules/</code>, <code>test/</code>, <code>plans/</code>, or
  source-map/build caches;
- keys, headers, browser profiles, logs, CRX/PEM files, or prior ZIPs.

## Steps

### Step 1: Add artifact and version regression tests

Create <code>test/package.test.mjs</code> covering:

- canonical include set;
- forbidden paths/extensions;
- every manifest HTML/script/icon/resource reference exists in the staged
  archive;
- README local links included in the archive resolve or are explicitly
  rewritten for the packaged README;
- package and manifest versions are exactly equal;
- a supplied release tag equals <code>v + version</code>;
- ZIP entries use forward slashes, stable ordering, and no absolute/traversal
  path.

Use temporary directories only. Do not write test artifacts into source
folders.

**Verify**: focused tests expose the current omitted files and missing
version-equality gate.

### Step 2: Implement one deterministic packaging command

Add a pinned dev-only ZIP library such as <code>archiver</code> and commit the
lockfile. Create <code>scripts/package-extension.mjs</code> that:

- owns the canonical allowlist above;
- validates versions/references before writing;
- writes to a temporary file then atomically replaces
  <code>typst-side-agent.zip</code>;
- uses stable sorted entry paths and deterministic metadata where supported;
- rejects symlinks, path traversal, forbidden sensitive extensions, and files
  outside the repository;
- accepts an optional expected release tag;
- prints a concise file count, byte count, version, and SHA-256, never file
  contents.

Add <code>package</code> and <code>package:check</code> scripts. The generated
ZIP is already ignored by <code>.gitignore</code>.

**Verify**: run packaging twice and assert identical SHA-256 output.

### Step 3: Make CI and release call the canonical command

Replace both handwritten <code>zip</code> blocks with
<code>npm ci</code> followed by the same package script.

In release:

- pass <code>github.event.release.tag_name</code> as the expected version;
- stop before credential-bearing publish if tag/package/manifest mismatch;
- upload exactly the artifact the package script verified.

Preserve plan 002's action SHAs, tag comments, permissions, and protected
environment.

**Verify**: workflow static tests prove no handwritten package allowlist
remains and both jobs invoke the same script.

### Step 4: Remove impossible current attachment producers and prompt branches

Treat fresh <code>read_document</code> and <code>read_diagnostics</code> tools
as canonical. Remove:

- unreachable document/diagnostics fields from current attachment payload
  builders;
- their system/context message branches after plan 007's context refactor;
- model-facing claims that a Diagnostics Add item exists.

For version-1 imported sessions, keep a narrow display-only compatibility
normalizer in the import/render layer so valid historical
<code>sent.document</code> or diagnostic-count badges can still be shown.
Legacy data must never be forwarded as new trusted model context.

Add a comment with removal criteria for the display-only compatibility path.

**Verify**: current composer/context tests contain only selection and preview
attachments; legacy import display test still passes.

### Step 5: Correct manual QA and release documentation

Replace impossible attachment checks with:

- selection, preview, opened image attachment checks;
- prompts that verify fresh <code>read_document</code> and
  <code>read_diagnostics</code> tool calls;
- approval checks from plan 007;
- package/version command;
- archive content check including privacy/testing files.

Update README project layout and contributing/release instructions to use
<code>npm run package</code>. Ensure privacy and testing links resolve inside
the archive.

**Verify**: stale-label search returns no current-feature claims.

### Step 6: Run an artifact-level smoke check

Unzip the generated artifact into a temporary directory and:

- load it with the plan 001 browser smoke;
- confirm manifest references resolve;
- confirm side panel and service worker start;
- confirm privacy/testing documents are present;
- confirm no forbidden file is present.

Do not use the source checkout as the extension path for this final gate.

**Verify**: <code>npm run package:check</code> and artifact browser smoke exit
0.

## Test plan

- Canonical allowlist and forbidden path tests.
- Deterministic double-build checksum.
- Manifest/reference and README-link resolution.
- package/manifest/tag equality and mismatch failure.
- Workflow static assertion for canonical command.
- Current attachment producer absence and legacy import display compatibility.
- Browser smoke from the unpacked ZIP, not source.

## Done criteria

- [ ] <code>npm run package</code> is the only packaging implementation.
- [ ] Two clean package runs produce identical SHA-256 output.
- [ ] CI and release call the canonical command.
- [ ] Release fails before publish on tag/version mismatch.
- [ ] ZIP includes README, PRIVACY, TESTING, LICENSE, manifest, source, docs,
  and icons.
- [ ] ZIP excludes tests, plans, git metadata, dependencies, credentials,
  profiles, and logs.
- [ ] Every packaged local link/reference resolves.
- [ ] Current UI/docs contain no nonexistent Full document/Diagnostics Add
  actions.
- [ ] Fresh read tools are canonical; legacy imports remain display-only.
- [ ] Focused tests, <code>npm run verify</code>,
  <code>npm run package:check</code>, and artifact browser smoke pass.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 013 is marked DONE.

## STOP conditions

Stop and report if:

- A required packaged file falls outside the canonical set and its purpose
  cannot be proven from manifest/runtime references.
- The ZIP library introduces a reachable high/critical advisory or remote
  runtime dependency.
- Deterministic output cannot be achieved with the selected library.
- Plan 002's immutable action pins or permissions would need to be weakened.
- Valid released session exports require legacy attachment data as active
  model context rather than display-only history.

## Maintenance notes

- Add every new runtime asset to the package manifest and artifact tests in
  the same change.
- Version bumps should change package and manifest together; release tags are
  validated, not manually trusted.
- Do not package this <code>plans/</code> directory.
- Remove legacy display compatibility only after an explicit support-window
  decision and migration evidence.
