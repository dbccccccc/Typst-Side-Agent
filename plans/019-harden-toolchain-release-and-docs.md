# Plan 019: Harden the supported toolchain, release gates, lint, and docs

> **Executor instructions**: Follow every step and gate. Preserve immutable
> GitHub Action pins, least-privilege permissions, deterministic packaging, and
> the protected publish job. Touch only in-scope files. The reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5bf9eed -- package.json package-lock.json eslint.config.js .github scripts test README.md TESTING.md src/background/agent.js src/background/storage.js src/content/diagnostics.js src/sidepanel/app.js`
> Compare the live workflow/tooling excerpts below. Changed package manager,
> artifact flow, or action permissions are a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none; execute after plans 014–018 in the cumulative branch
- **Category**: migration, dx, docs, tests, security
- **Planned at**: commit `5bf9eed`, live-worktree audit 2026-08-14

## Why this matters

The project still promises and tests Node 20 after its 2026 end of life. CI
invokes `npx playwright` even though only the differently named, pinned
`playwright-core` CLI is locked, so a clean runner may download an undeclared
version. The documented full dependency audit is not a release gate. Small
release and lint gaps—the hard-coded `1.0.1` test, malformed checklist fence,
and six unused bindings—also create avoidable drift.

## Current state

- `package.json:8-10` declares `node >=20.19.0`; CI tests `20.19.0` and `22`.
  Current ESLint packages already require `^20.19 || ^22.13 || >=24`.
- Node 20 reached official EOL on 2026-03-24. Supported targets for this plan
  are minimum Node 22.13 and current LTS Node 24; do not add Node 26 Current as
  a required compatibility lane.
- `package.json` pins `playwright-core@1.62.1`, whose lockfile binary is
  `playwright-core`, while both workflows and `TESTING.md` invoke
  `npx playwright install`.
- `TESTING.md:44-54` correctly requires a full audit because Marked and
  DOMPurify are copied into the shipped artifact, but `verify` and workflows do
  not run an advisory gate.
- `test/package.test.mjs:19-23` hard-codes tag/version `v1.0.1` and `1.0.1`.
- `TESTING.md:340-349` leaves `npm audit` unindented inside a list fence; Marked
  renders release steps 5–9 as code.
- `eslint.config.js` has strong correctness rules but no `no-unused-vars`.
  A diagnostic run found six current bindings, including unused imports in
  `agent.js`/`app.js` and unused diagnostic parameters.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `node --test test/package.test.mjs test/static.test.mjs` | all pass |
| Lint | `npm run lint` | exit 0, including unused bindings |
| Full verification | `npm run verify` | exit 0 |
| Dependency gate | `npm run audit:release` | exit 0, zero unwaived high/critical advisories |
| Browser install | `npx --no-install playwright-core install chromium` | uses locked local CLI; exit 0 |
| Browser smoke | `npm run test:browser` | exit 0 |
| Package | `npm run package && npm run package:check` | deterministic artifact verifies |
| Patch hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `package.json` and `package-lock.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release-chrome.yml`
- `eslint.config.js`
- `scripts/check-dependency-audit.mjs` (create)
- `scripts/vendor-sidepanel-libs.mjs` only if audit reachability metadata is
  exported from its existing artifact list
- `scripts/list-shipped-js.mjs` only for its stale supported-Node comment
- `test/package.test.mjs`
- `test/static.test.mjs`
- `test/browser/smoke.test.mjs` for installer guidance text and the bounded
  stream-work/service-worker-recovery assertions exposed by the required
  installed-browser rerun
- `src/background/agent.js`
- `src/background/storage.js`
- `src/content/diagnostics.js`
- `src/sidepanel/app.js`
- `README.md` and `TESTING.md`

**Out of scope**:

- Updating Marked or DOMPurify major versions without an advisory/compatibility
  reason.
- Changing Action SHAs, workflow permissions, release trigger, environment, or
  Chrome credentials.
- Adding a formatter, pre-commit framework, or bundler.
- Failing release on low/moderate advisories by default.
- Publishing a release or downloading credentials.

## Git workflow

- Branch: `codex/019-harden-release-toolchain`
- Suggested commits:
  - `ci: use supported locked toolchain`
  - `build: gate release dependencies`
  - `chore: enforce unused binding lint`
  - `docs: repair release checklist`
- Do not push, release, or merge into the user's branch.

## Steps

### Step 1: Raise and test the Node support floor

Set package/lockfile engines and onboarding docs to `>=22.13.0`. Change CI to
test minimum 22.13 and Node 24 LTS. Run browser smoke on one clearly named LTS
lane, preferably 24, and use the same supported LTS for packaging/release.

Update static policy tests so future EOL-lane removal does not require hunting
for unrelated literals. Do not use an unpinned `latest` selector.

**Verify**: focused static tests pass and workflow search contains neither
`20.19.0` nor a Node 20 lane.

### Step 2: Use the locked Playwright CLI everywhere

Replace every install instruction/workflow command with:

`npx --no-install playwright-core install --with-deps chromium`

Use the locked binary directly if the installed npm version does not support
that exact invocation. Add static assertions that workflows never call
`npx playwright` and always use `--no-install`. Update browser-smoke error text
and TESTING instructions consistently.

**Verify**: local locked CLI reports version 1.62.1 and focused static tests
pass without downloading a different npm package.

### Step 3: Add a release-aware dependency audit gate

Create a small Node script that invokes/consumes full `npm audit --json` and
fails on unwaived high/critical advisories. Because release-reachable packages
are dev-declared, never use `--omit=dev`.

If waivers are supported, each committed waiver must contain exact package and
advisory identifiers, a written reason, and an expiry date; expired or broad
wildcard waivers fail. Keep the default waiver set empty. The script must emit
counts/package names only, never environment values.

Add `audit:release` to package scripts and run it after `npm ci` in CI and the
release build before packaging. Keep `verify` network-independent; do not make
ordinary offline lint/tests depend on registry availability.

**Verify**: parser fixtures cover zero advisories, release-reachable high,
test-only high classification/waiver, malformed JSON, expired waiver, and audit
command failure. Live `npm run audit:release` exits 0.

### Step 4: Enforce unused bindings narrowly

Enable `no-unused-vars` for source and Node files with documented underscore
ignore patterns and `ignoreRestSiblings` where intentional discard is used.
Remove the current six unused imports/parameters/bindings; do not suppress
individual findings unless the binding documents a required interface.

Add a static/lint test only if configuration drift is otherwise easy; ESLint
itself is the primary gate.

**Verify**: `npm run lint` exits 0 and a temporary diagnostic override is no
longer needed.

### Step 5: Derive release tests and repair Markdown

In `test/package.test.mjs`, read the live package version, validate
`v${version}`, and generate a guaranteed-different valid tag for the negative
case. Do not weaken manifest/package equality.

Indent `npm audit` consistently inside release checklist item 4. Add a small
Marked regression assertion that steps 5–9 render as ordered-list items, not a
code block. Preserve the intentional double browser-smoke release check.

**Verify**: focused package/static tests pass and rendered release HTML contains
an ordered list through item 9.

### Step 6: Run complete supported-toolchain and artifact gates

Run install/verify/audit/browser/package checks under the current environment;
CI supplies cross-version confirmation. Confirm workflow action pins and
permissions are byte-identical except required command/context changes.

**Verify**: all commands in the table pass and `git diff --check` has no output.

## Test plan

- Static Node matrix/minimum policy.
- Locked Playwright command and no undeclared CLI calls.
- Audit JSON classifier, failures, exact/expired waivers.
- Version test derived from metadata and mismatched tag.
- Markdown render structure through release item 9.
- ESLint reports a deliberately unused fixture binding, then clean tree passes.

## Done criteria

- [ ] Node support is minimum 22.13 plus Node 24 LTS CI coverage; no Node 20
      promise remains.
- [ ] Chromium install uses only pinned `playwright-core` with `--no-install`.
- [ ] CI and release run a full high/critical dependency gate after `npm ci`.
- [ ] Ordinary `npm run verify` remains network-independent.
- [ ] `no-unused-vars` is enforced with narrow intentional-discard rules and
      current violations are removed.
- [ ] Release-version tests derive from package metadata.
- [ ] The checklist renders all nine steps correctly.
- [ ] Immutable action pins, read-only permissions, protected publish, and
      deterministic packaging remain intact.
- [ ] Focused/full tests, audit, browser smoke, package checks, and diff hygiene
      pass.
- [ ] No out-of-scope files changed.

## STOP conditions

Stop and report if:

- A required dependency does not support Node 22.13 or 24.
- The locked `playwright-core` CLI cannot install its matching browser revision.
- A release audit policy cannot distinguish/waive a test-only advisory without
  globally omitting dev dependencies.
- Any change would loosen workflow permissions, action pinning, or publish
  environment review.

## Maintenance notes

- Revisit the minimum when Node 22 reaches EOL; keep two supported LTS lanes,
  not an obsolete compatibility promise.
- Update audit waivers only with expiry and review evidence.
- Version bumps should change package/manifest/lock metadata, not test literals.
