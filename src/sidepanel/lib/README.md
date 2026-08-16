# Vendored side-panel libraries

The extension ships these browser artifacts locally; it never loads renderer
code from a CDN.

| Package | Version | Upstream | License | Artifact |
| --- | --- | --- | --- | --- |
| Marked | 12.0.0 | https://github.com/markedjs/marked | MIT | `marked.min.js` |
| DOMPurify | 3.4.13 | https://github.com/cure53/DOMPurify | MPL-2.0 OR Apache-2.0 | `purify.min.js`, `purify.min.js.map` |

Versions and SHA-256 values are pinned in `scripts/vendor-sidepanel-libs.mjs`.
After reviewing a dependency update, run `npm run vendor:update`, inspect the
bundle diff, and run `npm run vendor:verify` plus the hostile-rendering tests.
The upstream license texts remain distributed in each pinned npm package and
their license terms are recorded above.
