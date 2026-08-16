# Roadmap

This roadmap records likely maintenance directions, not release commitments or
promised timelines. The v1.1.0 correctness, security, browser, and packaging
gates do not depend on these structural follow-ups.

## Streaming ownership and instrumentation

The main streaming hot paths are bounded: unfinished content appends only its
new suffix, completed segments cross one Markdown/sanitization boundary, and
editor mutations do not trigger broad preview/workspace rescans.

A future refactor can move the remaining streaming state machine out of
`src/sidepanel/chat.js` into a focused controller and add packaged-browser
operation counters. The goal is easier direct testing and regression diagnosis,
not a user-visible behavior change.

## Side-panel orchestration

`src/sidepanel/app.js` is the composition root and still coordinates send,
session, tab, snapshot, and controller transitions. Focused controllers already
own attachments, registry mutations, run-event acceptance, status UI, and
session commands.

A future change can move the remaining lifecycle state machines behind injected
controllers, reduce `app.js`, and add direct concurrency tests without changing
the UI or storage formats.

## Storage decomposition

`src/background/storage.js` safely serializes mutations and owns settings,
sessions, checkpoints, snapshots, and migration. It is intentionally still one
large module.

A future change can split those domains behind one stable facade and one
transaction coordinator. Existing storage keys, retention limits, import/export
formats, and service-worker call sites should remain compatible.

## Proposing roadmap work

Open a focused GitHub issue describing the user or maintainer benefit, intended
scope, compatibility constraints, and verification strategy before beginning a
large roadmap refactor. See [CONTRIBUTING.md](./CONTRIBUTING.md).
