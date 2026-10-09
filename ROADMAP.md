# Roadmap

This roadmap records likely maintenance directions, not release commitments or
promised timelines. The release gates do not depend on these follow-ups.

## Completed structural work

The decomposition items from the 1.1.0 roadmap shipped in 1.1.1:
storage is split into one store per domain behind `storage.js`, the agent run
loop and tool runners live under `src/background/agent/`, the side panel's
send flow, transcript renderer, snapshot controller, and settings tabs are
separate modules, and the content scripts share one generated copy of the
dependency-free shared leaves instead of hand-synchronized duplicates. Every
side-panel rendering module, including the snapshot controller, is covered by
jsdom tests in addition to the packaged browser smoke.

## Optional host permissions

The manifest requests access to every HTTPS and HTTP origin so the worker can
reach user-configured model, custom-tool, and MCP endpoints. Moving those
origins to `optional_host_permissions` and requesting the exact origin when an
integration is saved would narrow the installed footprint. The change needs a
decision on upgrade behavior for existing installs, a settings-side permission
prompt, a structured error when a saved endpoint lacks a grant, and a browser
smoke that can grant permissions, so it is tracked here rather than done
silently.

## Renderer library upgrade

Marked is pinned at 12.0.0 and the renderer hooks in `src/sidepanel/markdown.js`
use that major version's positional renderer signature. Upgrading past it
requires adapting the `link`, `image`, and `html` hooks to the token-object
signature and re-running the hostile-Markdown assertions in the DOM tests and
the browser smoke.

## Composition root

`src/sidepanel/app.js` still owns tab synchronization, the context-attachment
chips and menus, and run-recovery glue. Those could follow the send flow into
injected controllers with their own DOM tests; no behavior change is implied.

## Proposing roadmap work

Open a focused GitHub issue describing the user or maintainer benefit, intended
scope, compatibility constraints, and verification strategy before beginning a
large roadmap refactor. See [CONTRIBUTING.md](./CONTRIBUTING.md).
