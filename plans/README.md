# Typst Side Agent Improvement Tracker

Generated from a standard whole-repository audit on 2026-08-07. The plans were
written against commit <code>5bf9eed</code>. This directory is the authoritative
tracker for resolving the confirmed findings; source code must not be changed
merely to update this index.

A follow-up audit on 2026-08-14 evaluated the much larger live remediation
worktree and added plans 014–021. Those plans reconcile gaps that remained after
001–013 were marked DONE; they do not rewrite the earlier completion record.

Each executor must read its plan completely, run the drift check first, honor
the scope and STOP conditions, run every verification gate, and update the
corresponding status row here. Do not start a plan whose dependencies are not
DONE.

## Baseline recorded during the audit

- <code>npm test</code>: 59 tests passed, 0 failed.
- <code>npm run check</code>: exited 0.
- <code>npm audit --omit=dev --json</code>: no declared-package
  vulnerabilities.
- Loaded-source line coverage:
  - <code>src/background/agent.js</code>: 22.24%
  - <code>src/background/mcp.js</code>: 31.86%
  - <code>src/background/storage.js</code>: 43.98%
  - aggregate loaded sources: 52.46%
- The git worktree was clean on <code>main...origin/main</code>.
- A manual Edge smoke check confirmed typst.app injection, live preview
  detection, and selection-to-agent handling. It did not verify an
  authenticated model request, the complete side-panel stream, a real custom
  tool, or a real MCP server.

## Execution order and status

| Plan | Audit finding | Title | Priority | Effort | Depends on | Status |
|------|---------------|-------|----------|--------|------------|--------|
| [001](001-establish-verification-baseline.md) | TEST-01 + DX hardening | Establish coverage of dangerous browser boundaries | P1 | L | — | DONE |
| [002](002-harden-release-actions.md) | CI-01 | Pin and constrain release automation | P1 | S | 001 | DONE |
| [003](003-isolate-agent-runs.md) | RUN-01 | Bind every run to its originating tab and session | P1 | L | 001 | DONE |
| [004](004-validate-tool-dispatch.md) | TOOL-01 | Validate tool registries and arguments fail-closed | P1 | M | 001 | DONE |
| [005](005-sanitize-chat-rendering.md) | RENDER-01 + dependency hardening | Sanitize model/imported content and track renderer dependencies | P1 | M | 001 | DONE |
| [006](006-propagate-cancellation.md) | CANCEL-01 | Propagate cancellation through every run operation | P2 | S | 003 | DONE |
| [007](007-gate-untrusted-side-effects.md) | SAFE-01 + endpoint/storage hardening | Separate untrusted content and authorize side effects | P1 | L | 003, 004 | DONE |
| [008](008-complete-mcp-transport.md) | MCP-01 | Implement a declared, protocol-complete MCP transport | P1 | L | 004, 006 | DONE |
| [009](009-redesign-session-storage.md) | STORE-01 | Make session storage transactional, bounded, and minimal | P1 | L | 003, 005 | DONE |
| [010](010-replace-dom-polling.md) | PERF-01 | Replace continuous whole-page polling with events | P2 | M | 001 | DONE |
| [011](011-batch-stream-rendering.md) | PERF-02 | Batch stream transport and rendering work | P2 | M | 003, 005 | DONE |
| [012](012-consolidate-runtime-protocol.md) | PROTO-01 | Consolidate the runtime protocol and feature controllers | P2 | L | 003, 006 | DONE |
| [013](013-unify-packaging-and-docs.md) | REL-01 + stale/dead documentation | Unify packaging, version gates, legacy cleanup, and release docs | P3 | M | 001, 002, 004, 005, 007 | DONE |
| [014](014-make-run-admission-and-cancellation-atomic.md) | RUN-02 + CANCEL-02 | Make run admission and cancellation atomic | P1 | L | 003, 006, 009, 012 | DONE |
| [015](015-harden-snapshot-scope-diff-and-ui.md) | SNAP-01 + DIFF-01 + TEST-02 | Make snapshot recovery scope-safe, bounded, and fully tested | P1 | L | 014 | DONE |
| [016](016-make-session-and-recovery-storage-conflict-safe.md) | STORE-02 + HISTORY-01 | Make session and recovery storage conflict-safe | P1 | L | 014 | DONE |
| [017](017-make-tool-and-edit-semantics-exact.md) | TOOL-02 + TREE-01 + EDIT-01 | Make tool ordering, file-tree, and edit semantics exact | P1 | L | 014, 016 | DONE |
| [018](018-bound-stream-and-dom-observer-work.md) | PERF-03 + PERF-04 | Bound streaming render and Typst DOM observation work | P2 | L | 014, 017 | DONE |
| [019](019-harden-toolchain-release-and-docs.md) | CI-02 + DX-02 + DOCS-02 | Harden the supported toolchain, release gates, lint, and docs | P2 | M | — | DONE |
| [020](020-complete-sidepanel-controller-ownership.md) | ARCH-03 | Complete side-panel controller ownership and shrink app.js | P2 | L | 014, 015, 018, 019 | DONE |
| [021](021-split-storage-behind-one-coordinator.md) | ARCH-04 | Split storage repositories behind one transaction coordinator | P2 | L | 016 | DONE |

## Follow-up audit baseline (2026-08-14)

- Audited the live <code>codex/fix-remediation-tracker</code> worktree at commit
  <code>5bf9eed</code>; it contained 10,811 tracked insertions, 2,783 tracked
  deletions, and many untracked source/test files beyond that commit.
- <code>npm run verify</code>: 248 tests passed, 0 failed; 47 source modules
  passed syntax, import-layer, cycle, raw-protocol-literal, vendor-integrity,
  and coverage gates.
- Loaded-source coverage: 76.16% lines, 71.89% branches, 80.00% functions.
- <code>npm run test:browser</code>: passed against the packaged MV3 extension.
- Full <code>npm audit --json</code>: zero advisories at every severity.
- <code>git diff --check</code>: no whitespace errors.

## Completion evidence (2026-08-08)

- <code>npm run verify</code>: passed; 126 tests, 0 failures.
- Coverage floors passed: <code>agent.js</code> 68.30% (65% floor),
  <code>mcp.js</code> 85.50% (80% floor), and <code>storage.js</code>
  82.31% (75% floor); aggregate loaded-source line coverage is 86.12%.
- <code>npm run test:browser</code>: passed twice against independently loaded
  packaged MV3 instances, including bridge, streaming, hostile-rendering, and
  stale-registration extension-reload recovery cases.
- Canonical package: 62 files, 672,981 bytes, reproducible SHA-256
  <code>81de45b0d7c8a161e19485530a99d0a5e7457a791a2a8695bf2e951e22ef5aeb</code>.
- <code>npm audit --omit=dev</code>: 0 vulnerabilities.
- <code>git diff --check</code>: exited 0.

Status values:

- <code>TODO</code>
- <code>IN PROGRESS</code>
- <code>DONE</code>
- <code>BLOCKED: reason</code>
- <code>REJECTED: rationale</code>

## Dependency notes

- Plan 001 lands first because the agent loop, MCP transport, storage
  mutations, Chrome message bridges, and packaged extension startup currently
  lack adequate regression coverage.
- Plans 003, 004, and 005 are the initial correctness and rendering
  guardrails. They may be worked in parallel after plan 001.
- Plan 006 builds on the per-run controller introduced by plan 003.
- Plan 007 requires stable run identity and validated tool calls before adding
  approval state.
- Plan 008 consumes both the validated tool contract and the unified
  cancellation signal.
- Plan 009 assumes run/session identity is no longer global and imported
  messages have a validated shape.
- Plan 011 assumes streamed content already passes through the safe renderer.
- Plan 012 consolidates the minimal run envelope introduced by plan 003; it
  must not replace that work with an incompatible second protocol.
- Plan 013 is last because it updates documentation and packaging assertions
  for behavior established by several earlier plans.
- Plan 002 and plan 010 are otherwise independent and may be executed while
  the P0 stream is underway, provided their declared dependencies are DONE.
- Plan 014 follows the earlier run/cancellation work because it closes the
  untested reservation-to-start window and establishes session-level ownership.
- Plan 015 depends on 014 so terminal snapshot maintenance observes the final
  sticky cancellation and immutable run identity.
- Plan 016 depends on 014's same-session admission, then adds durable revision,
  atomic append, and publish-before-cleanup semantics. Both layers must remain.
- Plan 017 follows 016 because exact tool receipts are persisted through the
  normalization/storage paths it changes.
- Plan 018 follows 017 so stream rendering tests observe final tool-segment and
  edit-receipt shapes.
- Plan 019 is behaviorally independent but is ordered before the structural
  plans to avoid repeatedly touching workflow, lint, and small unused imports.
- Plan 020 follows the run, snapshot, rendering, and tooling plans so it moves
  stable side-panel behavior behind controllers rather than moving targets.
- Plan 021 follows 016 and is strictly an extraction of its characterized
  storage invariants. It must retain one shared transaction coordinator.

## Completion policy

A plan may be marked DONE only when:

1. Every checkbox in its Done criteria is satisfied.
2. Its focused tests and <code>npm run verify</code> pass.
3. <code>git diff --check</code> passes.
4. No files outside its declared scope changed.
5. The executor records any intentional user-visible behavior change in the
   named documentation files.

If the repository has drifted from a plan excerpt, update the plan in a
separate planning change or stop and request review. Do not silently reinterpret
the plan.

## Coverage map

All confirmed audit findings and smaller hardening items are assigned:

- Wrong-tab, wrong-project, wrong-session, and cross-panel routing: plan 003.
- Malformed arguments, missing schema enforcement, and tool-name collisions:
  plan 004.
- Unsafe model/import rendering and invisible vendored Markdown provenance:
  plan 005.
- Stop/cancellation gaps: plan 006.
- Prompt-injected side effects, approval policy, cleartext endpoint warnings,
  and trusted-only storage access: plan 007.
- MCP versioning, framing, pagination, discovery caching, and transport tests:
  plan 008.
- Quota pressure, raw payload retention, exports, migrations, and concurrent
  storage writes: plan 009.
- 220 ms DOM polling: plan 010.
- per-token runtime messages, full Markdown reparses, forced scrolling: plan
  011.
- duplicated string message routers, missing protocol documentation, and
  oversized mutable controllers: plan 012.
- mutable release-action references: plan 002.
- duplicated package allowlists, omitted privacy file, version drift, stale QA
  steps, and obsolete attachment branches: plan 013.
- semantic linting, one-command verification, coverage gates, and packaged
  MV3 smoke testing: plan 001.
- Pre-start cancellation, bounded tombstones, and same-session run admission:
  plan 014.
- Terminal snapshot tab/file scope, bounded diff work, and restore UI state
  coverage: plan 015.
- Idempotent tool-result history, revision-aware session writes, atomic
  transcript append, and crash-consistent recovery cleanup: plan 016.
- File-dependent tool ordering, conservative tree completeness, physical line
  deletion, and honest reviewed-diff receipts: plan 017.
- Linear streamed Markdown work, explicit Typst preview/Files observers, and
  streaming-controller extraction: plan 018.
- Supported Node LTS policy, locked browser installation, release audit gate,
  unused-binding lint, version tests, and release Markdown: plan 019.
- Actual side-panel session/send/tab controller ownership: plan 020.
- Storage repository decomposition behind one coordinator: plan 021.

## Future product directions — not defect plans

These directions were intentionally unscheduled until the defect plans above
landed. The first has now shipped:

1. **Implemented 2026-08-10:** reviewable edit transactions and response-level
   one-click revert, using a bounded checkpoint journal outside chat storage.
2. Path-aware, multi-file workspace reads and edits. Prerequisites: plans 003,
   004, 010, and 012. Start with a read-only design spike.
3. Versioned per-project profiles and safely portable configuration bundles.
   Prerequisites: plans 004, 007, and 009. Credentials and authorization
   headers must be excluded from exports by default.

Creating build plans for these directions requires an explicit maintainer
decision; they are not necessary to close this tracker.

## Findings considered and rejected

- Replacing native ES modules with React, TypeScript, or a general bundler:
  no evidence justifies a platform rewrite. Preserve the load-unpacked,
  no-runtime-build workflow.
- A blanket repository-wide 80% coverage target: it would reward shallow
  tests. Plans instead require named coverage of mutation, transport, storage,
  and browser boundaries.
- Authenticated typst.app end-to-end tests on every pull request: credentials
  and upstream UI instability make that unsuitable for CI. Use local fixtures
  in CI and retain real-site release QA.
- Treating broad HTTP/HTTPS host permissions as a vulnerability by themselves:
  arbitrary user-configured endpoints are an intentional feature. Plan 007
  adds transport warnings and approval boundaries without removing that
  capability.
- Treating browser-local credential storage as proof of compromise: no
  committed credential was found. Plan 007 adds trusted-context access as
  defense in depth.
- Labeling user-configured custom or MCP endpoints as SSRF: this is a browser
  client calling destinations selected by its user, not a server-side
  untrusted-URL fetch boundary.
- Declaring Marked 12 vulnerable merely because it is old: no reachable
  advisory was established. Plan 005 makes provenance reproducible and fixes
  the actual unsafe rendering boundary.
- Minification, code splitting, chat virtualization, and a CSS-only split:
  none outranks the measured DOM polling, stream rendering, or storage work.
