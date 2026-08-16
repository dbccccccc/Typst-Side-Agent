# Typst Grammar Documentation Collection

> Target: **Typst 0.15.1**. Last reviewed: **2026-08-08**.
>
> A topic-separated, agent-oriented condensation of the official Typst reference. It is bundled with the extension and does not fetch documentation at runtime.

## Version and Provenance

This collection was reviewed against the current [Typst 0.15.1 documentation](https://typst.app/docs/), the [0.15.0 changelog](https://typst.app/docs/changelog/0.15.0/) (the complete language/compiler delta from 0.14.2), the corrective [0.15.1 changelog](https://typst.app/docs/changelog/0.15.1/), and the live [language reference](https://typst.app/docs/reference/).

The 0.15 refresh covers the new `path` type and forward-slash-only paths; collection, calculation, and integer additions; variable fonts; math and baseline behavior; page bleed; spot colors and tiling offsets; `within` selectors and counter display locations; bundle documents/assets; dividers; multiple bibliographies; XML namespaces; and removed 0.14 compatibility APIs.

This is a concise reference, not a verbatim mirror. When updating it again:

1. Change `DOCS_TYPST_VERSION` and `DOCS_REVIEWED_DATE` in `src/background/docs.js`.
2. Review every release note since the recorded version and the affected live API pages.
3. Update the topic files and keep the version banner in each one consistent.
4. Run `npm run verify`, `npm run package`, and `npm run package:check`.

---

## Collection Structure

Read in order for systematic learning, or jump to specific topics:

| # | File | Topic | Description |
|---|------|-------|-------------|
| 01 | [`01-syntax-basics.md`](01-syntax-basics.md) | **Syntax Basics** | Modes, literals, operators, comments, identifiers, paths |
| 02 | [`02-markup.md`](02-markup.md) | **Markup** | Paragraphs, headings, lists, emphasis, links, labels |
| 03 | [`03-math.md`](03-math.md) | **Math** | Equations, fractions, matrices, symbols, styles |
| 04 | [`04-scripting.md`](04-scripting.md) | **Scripting** | Variables, functions, control flow, blocks, modules |
| 05 | [`05-types.md`](05-types.md) | **Types** | All primitive types, methods, calc module |
| 06 | [`06-styling.md`](06-styling.md) | **Styling** | Set rules, show rules, selectors |
| 07 | [`07-context-introspection.md`](07-context-introspection.md) | **Context** | Context system, counters, states, queries |
| 08 | [`08-layout.md`](08-layout.md) | **Layout** | Page, alignment, spacing, grids, positioning |
| 09 | [`09-visualize.md`](09-visualize.md) | **Visualize** | Images, shapes, colors, gradients, strokes |
| 10 | [`10-model-elements.md`](10-model-elements.md) | **Model** | Document structure, figures, tables, outlines |
| 11 | [`11-data-loading.md`](11-data-loading.md) | **Data Loading** | CSV, JSON, XML, YAML, TOML, CBOR |
| 12 | [`12-cheat-sheet.md`](12-cheat-sheet.md) | **Cheat Sheet** | Quick reference for common patterns |

---

## Typst at a Glance

Typst is a markup-based typesetting system with three syntactical modes:

- **Markup mode** (default) — `*bold*`, `_italic_`, `= Heading`, `- list`
- **Code mode** — variables, functions, logic: `#let x = 5`, `#if ...`, `#for ...`
- **Math mode** — `$x^2 + y^2 = z^2$`

Core concepts:
- **Set rules** configure elements: `#set heading(numbering: "1.")`
- **Show rules** transform elements: `#show heading: it => [..]`
- **Content** is the core type; functions produce and manipulate content
- **Context** enables reactive, position-aware content

---

## Learning Path

1. **Beginner**: 01 → 02 → 03 → 12
2. **Intermediate**: 04 → 05 → 06 → 08
3. **Advanced**: 07 → 09 → 10 → 11

---

## Official Documentation

- [typst.app/docs](https://typst.app/docs/) — Full documentation
- [typst.app/universe](https://typst.app/universe/) — Packages
- [forum.typst.app](https://forum.typst.app) — Community forum

---

*Generated from official Typst documentation. Maintained for AI agent consumption — concise, comprehensive, and topic-organized.*
