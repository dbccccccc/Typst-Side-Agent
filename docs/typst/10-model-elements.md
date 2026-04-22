# Typst Model Elements

> Document structure elements: document metadata, headings, figures, tables, footnotes, outlines.

---

## Document

Root element with metadata.

```typc
document(
  title: none|content,
  author: array,
  keywords: array,
  date: none|auto|datetime,
) -> content
```

```typst
#set document(
  title: "My Thesis",
  author: ("John Doe",),
  keywords: ("typst", "typesetting"),
  date: datetime.today(),
)
```

---

## Title

Creates a proper document title (distinct from a heading).

```typst
#title[My Document Title]
```

Turns into `<h1>` in HTML export. A top-level heading indicates a section, not the document title.

---

## Heading

```typc
heading(
  level: auto|int,
  depth: int,
  offset: int,
  numbering: none|str|function,
  supplement: none|auto|content|function,
  outlined: bool,
  bookmarked: auto|bool,
  body: content,
) -> content
```

```typst
= Top-level
== Section
=== Subsection

#set heading(numbering: "1.a)")
= Numbered Heading <sec:intro>
@sec:intro    // reference it
```

---

## Figure

```typc
figure(
  body: content,
  supplement: none|auto|content|function,
  numbering: none|str|function,
  numbering-separator: str,
  caption: none|content,
  kind: str|function,
  gap: length,
  outlined: bool,
) -> content
```

```typst
#figure(
  image("tiger.jpg", width: 80%),
  caption: [A magnificent tiger.],
) <fig:tiger>

// Table figure
#figure(
  table(columns: 2, [A], [B], [1], [2]),
  caption: [Sample data.],
  kind: table,
)

#show figure.where(kind: table): set figure.caption(position: top)
```

---

## Table

```typc
table(
  columns: auto|int|array,
  rows: auto|int|array,
  column-gutter: auto|...array,
  row-gutter: auto|...array,
  fill: none|color|gradient|pattern|function,
  align: auto|alignment|array|function,
  stroke: none|...function,
  inset: length|dictionary,
  ..cells: content,
) -> content
```

### Sub-elements

```typc
table.cell(x, y, colspan, rowspan, fill, align, inset, stroke, content)
table.hline(y, start, end, stroke)
table.vline(x, start, end, stroke)
table.header(..children)
table.footer(..children)
```

```typst
// Simple table
#table(
  columns: (1fr, 2fr),
  [*Name*], [*Description*],
  [Typst], [A typesetting system],
  [LaTeX], [The classic],
)

// With styling
#table(
  columns: 3,
  align: center,
  fill: (x, y) => if y == 0 { gray },
  stroke: (x, y) => if y == 0 { 2pt },
  table.header([A], [B], [C]),
  [1], [2], [3],
  [4], [5], [6],
  table.footer([Total], [15], []),
)

// Cell spanning
#table(
  columns: 3,
  table.cell(colspan: 2, fill: aqua)[Spanning],
  [Normal],
  [A], [B], [C],
)
```

---

## Footnote

```typc
footnote(number: none|int, marker: content|auto|none, ..body) -> content
```

```typst
Text with a note#footnote[This is the footnote content.]

// Custom marker
#footnote(marker: [*1])[First author note]
```

---

## Outline (Table of Contents)

```typc
outline(
  title: content,
  target: selector,
  depth: none|int,
  indent: auto|bool|length,
) -> content
```

```typst
// Default TOC (all headings)
#outline()

// List of figures
#outline(
  title: [List of Figures],
  target: figure.where(kind: image),
)

// List of tables
#outline(
  title: [List of Tables],
  target: figure.where(kind: table),
)

// Depth-limited
#outline(depth: 2)

// Custom title
#outline(title: [Contents])
```

---

## Numbering

Apply numbering patterns to integers.

```typc
numbering(pattern: str|function, ..numbers) -> content|str
```

### Patterns

| Pattern | Output |
|---------|--------|
| `"1"` | 1, 2, 3... |
| `"01"` | 01, 02, 03... |
| `"a"` | a, b, c... |
| `"A"` | A, B, C... |
| `"i"` | i, ii, iii... |
| `"I"` | I, II, III... |
| `"一"` | Chinese numerals |
| `"*"` | Symbols (*, dagger, etc.) |
| `"1.a.i"` | Composite |

```typst
#numbering("1.a)", 1, 2)   // "1.a)"
#numbering("I.1", 3, 5)    // "III.5"
```

---

## Bibliography

```typc
bibliography(
  path: str|array,
  title: content|auto|none,
  style: str,
) -> content
```

```typst
#bibliography("refs.bib")
#bibliography("refs.bib", style: "apa")
#bibliography(("refs.bib", "more.bib"), title: [References])
```

### Cite

```typc
cite(key: str|label, form: str, supplement: content|none) -> content
```

| Form | Example |
|------|---------|
| `"normal"` | [1] |
| `"author"` | Doe |
| `"year"` | 2024 |
| `"prose"` | Doe (2024) |
| `"full"` | Full entry |

```typst
As shown by @doe2024, ...
#cite(<doe2024>, form: "prose")
#cite(<doe2024>, supplement: [p. 42])
```

---

## Quote

```typc
quote(
  block: bool,
  quotes: auto|bool,
  attribution: none|label|content,
  body: content,
) -> content
```

```typst
Plato said #quote[I know that I know nothing].

#quote(block: true, attribution: [Plato])[
  ...I seem, then, in just this little thing to be wiser...
]
```

---

## Reference System Summary

```typst
// 1. Add a label
= Introduction <intro>
$ E = mc^2 $ <einstein>
#figure(..., caption: [...]) <fig:chart>

// 2. Reference it
@intro                    // "Section 1"
@intro[Chapter]           // "Chapter 1"
#ref(<intro>)             // explicit
#ref(<intro>, form: "page")  // page number
@einstein                 // "(1)"
@fig:chart                // "Figure 1"

// 3. Supplement auto-detection
#set heading(supplement: [Chapter])
#show figure: set figure(supplement: [Fig.])
```

---

## Summary: Element → Markup Shortcuts

| Markup | Element Function |
|--------|-----------------|
| `= Heading` | `heading[Heading]` |
| `- item` | `list.item[content]` |
| `+ item` | `enum.item[content]` |
| `/ Term: def` | `terms.item[Term][def]` |
| `*text*` | `strong[text]` |
| `_text_` | `emph[text]` |
| `` `code` `` | `raw("code")` |
| `https://...` | `link("https://...")` |
| `<label>` | `label("label")` |
| `@label` | `ref(<label>)` |
| `#footnote[...]` | `footnote[...]` |
