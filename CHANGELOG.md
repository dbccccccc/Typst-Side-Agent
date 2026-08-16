# Changelog

All notable changes to Typst Side Agent are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and release versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-08-16

### Added

- Atomic worker-owned run reservations, bounded pre-start cancellation
  tombstones, and one active owner per project/chat pair.
- Conservative project-tree completeness reporting and exact project-file
  retargeting for multi-file work.
- Trusted review receipts that distinguish an explicitly approved diff from
  automatic, revert, and snapshot writes.
- Full release dependency auditing and exact vendored third-party license texts.

### Changed

- Raised the supported Node.js floor to 22.13 and added Node 24 CI coverage.
- Limited tool reordering to safe, adjacent, non-overlapping line edits while
  preserving provider order across stateful barriers.
- Made streamed Markdown append incrementally as inert text and parse/sanitize
  only when a segment completes.
- Scoped Typst DOM observation to preview and Files surfaces while ignoring
  CodeMirror editor churn.
- Required two consecutive packaged Chromium smokes in CI and release builds.

### Fixed

- Made Stop and navigation cancellation sticky across preflight, reservation,
  persistence, and worker-start races.
- Corrected physical-line deletion at first, middle, final, CRLF, and
  multi-range boundaries.
- Repaired MV3 cold-worker recovery testing without requiring Playwright to
  produce a different Worker object.
- Prevented unknown or collapsed file-tree rows from being reported as a
  complete workspace view.

### Security

- Kept edit-approval provenance source-owned across the worker/page boundary.
- Added a fail-closed high/critical dependency audit to CI and release gates.

## [1.0.1] - 2026-05-22

- Added automated Chrome Web Store publication from verified, non-prerelease
  GitHub Releases.

## [1.0.0] - 2026-04-22

- Initial public release.

[Unreleased]: https://github.com/dbccccccc/Typst-Side-Agent/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/dbccccccc/Typst-Side-Agent/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dbccccccc/Typst-Side-Agent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dbccccccc/Typst-Side-Agent/releases/tag/v1.0.0
