# Typst Grammar Documentation Collection

> A topic-separated, concise, and efficient markdown collection for learning Typst, extracted from [typst.app/docs](https://typst.app/docs/).

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
