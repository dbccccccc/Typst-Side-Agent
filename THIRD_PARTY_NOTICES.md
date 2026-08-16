# Third-party notices

Typst Side Agent distributes the following third-party browser libraries inside
the extension. Their code and exact upstream license texts are vendored so the
release ZIP remains self-contained and does not load executable code from a CDN.

| Component | Version | Distributed files | License text |
|---|---:|---|---|
| [Marked](https://github.com/markedjs/marked) | 12.0.0 | `src/sidepanel/lib/marked.min.js` | [`LICENSE.marked.md`](./src/sidepanel/lib/LICENSE.marked.md) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.13 | `src/sidepanel/lib/purify.min.js`, `src/sidepanel/lib/purify.min.js.map` | [`LICENSE.dompurify-apache.txt`](./src/sidepanel/lib/LICENSE.dompurify-apache.txt), [`LICENSE.dompurify-mpl.txt`](./src/sidepanel/lib/LICENSE.dompurify-mpl.txt) |

The vendoring script pins each source file and license text by SHA-256. Run
`npm run vendor:verify` to check the committed copies or `npm run vendor:update`
after deliberately reviewing a dependency update.

These notices apply only to the listed third-party components. Typst Side
Agent's own source is distributed under the repository [MIT License](./LICENSE).
