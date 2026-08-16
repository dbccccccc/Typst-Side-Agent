# Plan 002: Pin and constrain release automation

> **Executor instructions**: Execute only after plan 001 is DONE. Run every
> verification gate. Never print or copy secret values. Update plan 002 in
> <code>plans/README.md</code> when complete.
>
> **Drift check (run first)**:
> <code>git diff --stat 5bf9eed..HEAD -- .github/workflows/ci.yml .github/workflows/release-chrome.yml .github/dependabot.yml test</code>
> Workflow drift that changes action names or secret handling is a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: <code>plans/001-establish-verification-baseline.md</code>
- **Category**: security, dx
- **Planned at**: commit <code>5bf9eed</code>, 2026-08-07

## Why this matters

The Chrome Web Store publishing step uses a mutable third-party action
reference while store credentials are present in the job. A moved or
compromised tag would change the code receiving those credentials. Full commit
pins, least-privilege workflow permissions, protected deployment environment
metadata, and automated pin updates make the release path reviewable.

## Current state

- <code>.github/workflows/release-chrome.yml:37-43</code> uses
  <code>browser-actions/release-chrome-extension@v0</code> with Chrome Web
  Store credential secret names.
- Checkout, setup-node, and upload-artifact also use mutable major tags in both
  workflow files.
- Neither workflow declares an explicit permissions block.
- The publish job has no <code>environment</code> declaration.
- Existing commit messages use prefixes such as <code>ci:</code> and
  <code>fix:</code>.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Resolve an action ref | <code>gh api repos/OWNER/REPO/git/ref/tags/TAG</code> | JSON containing an object SHA/type |
| Verify pins | <code>rg -n "uses:.*@(v[0-9]+|main|master)$" .github/workflows</code> | no matches |
| Project verification | <code>npm run verify</code> | exit 0 |
| Diff hygiene | <code>git diff --check</code> | no output |

Replace <code>OWNER/REPO/TAG</code> only with each action already present in
the workflows. If a tag object is annotated, dereference it through the
corresponding GitHub Git Tags API until the final object type is
<code>commit</code>. Record the tag name as a trailing YAML comment beside the
40-character commit SHA.

## Scope

**In scope**:

- <code>.github/workflows/ci.yml</code>
- <code>.github/workflows/release-chrome.yml</code>
- <code>.github/dependabot.yml</code> (create)
- A static workflow assertion under <code>test/</code> if plan 001 does not
  already provide one.

**Out of scope**:

- Changing Chrome Web Store credential values.
- Publishing an extension, GitHub release, tag, or pull request.
- Replacing the publishing vendor without separate review.
- Reworking artifact contents; plan 013 owns packaging.
- Repository/environment settings that cannot be represented in versioned
  files. Document those as a manual maintainer action instead.

## Git workflow

- Branch: <code>codex/002-harden-release-actions</code>
- Suggested commit: <code>ci: pin and constrain release actions</code>
- Do not push or publish.

## Steps

### Step 1: Resolve and document immutable action commits

For every <code>uses:</code> entry in both workflows:

1. Identify the current tag.
2. Resolve that exact tag from the action's official repository.
3. Dereference annotated tag objects to the underlying commit.
4. Replace the mutable tag with the full 40-character commit SHA.
5. Add a short comment preserving the human-readable tag.

Do not copy a SHA from an unauthenticated third-party blog or search result.
Use the GitHub repository that owns the action.

**Verify**:
<code>rg -n "uses:.*@(v[0-9]+|main|master)$" .github/workflows</code>
returns no matches, and
<code>rg -n "uses:.*@[0-9a-f]{40}" .github/workflows</code>
finds every action step.

### Step 2: Apply least privilege and a protected deployment boundary

Add <code>permissions: contents: read</code> at workflow or job level for CI
and release. Add <code>environment: chrome-web-store</code> to the publish job.
Do not add write permissions that current steps do not require.

Add a note near the environment declaration or in repository release
documentation stating that maintainers must configure required reviewers and
store credentials in that environment. Do not duplicate secret values or
rename existing secret references in this plan.

**Verify**: a static test parses or text-checks both workflow files and proves
that permissions are explicit and the publish job names the environment.

### Step 3: Add Dependabot coverage for GitHub Actions

Create <code>.github/dependabot.yml</code> with a GitHub Actions ecosystem
entry, repository root directory, and a reasonable monthly schedule. Keep
updates reviewable rather than automatically merging them.

**Verify**: the file parses as YAML in the verification tooling established by
plan 001, or a focused static test confirms its required fields.

### Step 4: Add a regression assertion

Add a static test that fails if:

- a workflow action uses a mutable major/main/master ref;
- either workflow loses its explicit permissions;
- the publishing action stops using the protected environment.

The test must not inspect environment secret values.

**Verify**: <code>npm run verify</code> exits 0.

## Test plan

- Model the test after <code>test/static.test.mjs</code>.
- Check action pin shape, not a hardcoded list of current SHAs; Dependabot
  updates should require normal review without rewriting test expectations.
- Check the release environment name and permissions.
- Add one test fixture or helper-level case proving a mutable ref is rejected
  if the parser is extracted.

## Done criteria

- [ ] Every action in both workflows uses a reviewed full commit SHA.
- [ ] Human-readable tag comments remain beside pins.
- [ ] CI and release explicitly use <code>contents: read</code>.
- [ ] The publishing job declares <code>chrome-web-store</code> environment.
- [ ] Dependabot monitors GitHub Actions monthly.
- [ ] <code>npm run verify</code> exits 0.
- [ ] The static regression test passes.
- [ ] <code>git diff --check</code> has no output.
- [ ] Only in-scope files changed.
- [ ] Plan 002 is marked DONE.

## STOP conditions

Stop and report if:

- An action tag cannot be resolved to a commit from its owning repository.
- A pinned action requires broader permissions than the current workflow.
- The publish action is archived, compromised, or no longer supports the
  current inputs; replacement is a separate decision.
- Workflow validation would require exposing a secret value.

## Maintenance notes

- Review each Dependabot action-pin update as executable supply-chain code.
- The protected environment must be configured in GitHub repository settings;
  the workflow declaration alone cannot enforce reviewers.
- Plan 013 will edit these workflows again to replace duplicated packaging
  commands; preserve the pins and permissions when resolving drift.

