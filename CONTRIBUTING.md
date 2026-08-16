# Contributing

Thanks for helping improve Typst Side Agent. Bug reports, focused fixes,
documentation corrections, and carefully scoped features are welcome.

Security vulnerabilities must follow [SECURITY.md](./SECURITY.md), not a public
issue or pull request.

## Development setup

Requirements:

- Node.js 22.13 or newer;
- npm;
- a Chromium-family browser with Manifest V3 support; and
- the Chromium revision installed by the pinned `playwright-core` package for
  automated browser smoke tests.

Install the exact dependency tree and run the source gate:

```bash
npm ci
npm run verify
```

Install the pinned browser used by CI when browser testing is needed:

```bash
npx --no-install playwright-core install --with-deps chromium
```

## Useful commands

| Command | Purpose |
|---|---|
| `npm test` | Run the fast Node test suite. |
| `npm run verify` | Run lint, syntax/import checks, vendor verification, tests, and coverage floors. |
| `npm run test:browser` | Build and exercise the canonical ZIP in pinned Chromium. |
| `npm run audit:release` | Query the npm advisory service and fail on unwaived high/critical advisories. |
| `npm run package` | Build the deterministic `typst-side-agent.zip`. |
| `npm run package:check` | Validate and reproduce the ZIP byte-for-byte. |

See [TESTING.md](./TESTING.md) for focused tests, manual QA, and the full release
checklist.

## Change guidelines

- Keep runtime code as plain JavaScript modules; there is no transpilation
  stage.
- Import message constants from `src/shared/protocol.js`. Do not duplicate raw
  protocol strings or bypass its exact validators.
- Treat page content, model output, and integration data as untrusted. Preserve
  the existing approval, endpoint, cancellation, size, and run-identity
  boundaries.
- Add a focused regression test for every reproducible defect and update public
  documentation when behavior, permissions, data flow, or release steps change.
- Update vendored libraries only through `npm run vendor:update`; review the
  code, license, provenance, and checksum changes together.
- Do not commit `node_modules`, browser profiles, credentials, logs, CRX/PEM
  files, or generated ZIP archives.

## Pull requests

Keep each pull request focused and explain the user-visible behavior, risk, and
verification performed. Before requesting review, run:

```bash
npm run verify
git diff --check
```

Run the browser smoke for page-bridge, side-panel, packaging, or service-worker
changes. Release-affecting changes should also run the audit, two consecutive
browser smokes, and deterministic package check described in `TESTING.md`.

Version bumps, tags, GitHub Releases, and Chrome Web Store publication are
maintainer release actions and should not be included in an unrelated pull
request.
