# Vendored side-panel libraries

The extension ships these browser artifacts locally; it never loads renderer
code from a CDN.

| Package | Version | Upstream | License | Artifacts | Vendored license text |
| --- | --- | --- | --- | --- | --- |
| Marked | 12.0.0 | https://github.com/markedjs/marked | MIT and bundled Markdown license | `marked.min.js` | `LICENSE.marked.md` |
| DOMPurify | 3.4.13 | https://github.com/cure53/DOMPurify | MPL-2.0 OR Apache-2.0 | `purify.min.js`, `purify.min.js.map` | `LICENSE.dompurify-mpl.txt`, `LICENSE.dompurify-apache.txt` |

Versions and SHA-256 values are pinned in `scripts/vendor-sidepanel-libs.mjs`.
After reviewing a dependency update, run `npm run vendor:update`, inspect the
bundle diff, and run `npm run vendor:verify` plus the hostile-rendering tests.
The exact upstream license texts are vendored beside the browser artifacts,
verified by SHA-256, and included in every release ZIP. See the repository-root
`THIRD_PARTY_NOTICES.md` for the public distribution notice.
