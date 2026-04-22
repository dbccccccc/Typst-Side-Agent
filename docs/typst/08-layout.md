# Typst Layout

> Page setup, alignment, spacing, grids, blocks, and positioning.

---

## Page

```typc
page(
  width: auto|relative,
  height: auto|relative,
  margin: auto|relative|dictionary,
  binding: auto|relative,
  columns: int,
  gutter: length,
  fill: none|color|gradient|tiling,
  numbering: none|str|function,
  number-align: alignment,
  header: none|content,
  footer: none|content,
  header-ascent: relative,
  footer-descent: relative,
  background: none|content,
  foreground: none|content,
  paper: str,
  flipped: bool,
  ..content,
) -> content
```

### Common Paper Sizes

`"a4"`, `"a5"`, `"letter"`, `"legal"`, `"tabloid"`, `"b5"`, `"a3"`, `"us-letter"`, `"us-legal"`, `"us-executive"`

### Margin Formats

```typst
#set page(margin: 1in)                    // all sides
#set page(margin: (x: 1in, y: 0.5in))     // horizontal / vertical
#set page(margin: (top: 1in, bottom: 0.5in, left: 1in, right: 0.5in)) // per side
#set page(margin: auto)                   // automatic (default ~2.5cm)
```

### Headers and Footers

```typst
#set page(
  header: align(right)[Draft],
  footer: context [
    #h(1fr)
    #counter(page).display("1 / 1", both: true)
  ],
)
```

Context-aware headers access current chapter, section, etc.

### Page Breaks

```typst
#pagebreak()                    // force new page
#pagebreak(weak: true)          // only if not at top
#pagebreak(to: "odd")           // next odd page
#pagebreak(to: "even")          // next even page
```

---

## Alignment

```typc
align(alignment, content) -> content
```

| Horizontal | Vertical |
|------------|----------|
| `left` / `start` | `top` |
| `center` / `end` | `horizon` |
| `right` | `bottom` |

Combined: `center + top`, `right + bottom`, `start + horizon`, etc.

```typst
#align(center)[Centered text]
#align(right + bottom)[Bottom-right]
#set align(center)            // set for scope
```

---

## Spacing

### Vertical Space

```typst
#v(1em)                // fixed vertical space
#v(1fr)                // fractional (fills available)
#v(1em, weak: true)    // removed at page breaks
```

### Horizontal Space

```typst
#h(1em)                // fixed horizontal
#h(1fr)                // push content apart
#h(1em, weak: true)    // removed at line breaks
```

### Padding

```typst
#pad(x: 1em, y: 0.5em)[Content]
#pad(left: 2em, right: 1em)[Content]
#pad(1em)[Equal on all sides]
```

---

## Block

Block-level container.

```typc
block(
  width: auto|relative,
  height: auto|relative|fraction,
  breakable: bool,
  fill: none|color|gradient|tiling,
  stroke: none|length|color|gradient|stroke|dictionary,
  radius: relative|dictionary,
  inset: relative|dictionary,       // inner padding
  outset: relative|dictionary,      // outer expansion
  spacing: relative|fraction,
  above: auto|relative|fraction,
  below: auto|relative|fraction,
  clip: bool,
  sticky: bool,
  none|content,
) -> content
```

```typst
#block(fill: luma(230), inset: 8pt, radius: 4pt, lorem(30))
#block(width: 100%, height: 200pt, [Fixed dimensions])
```

---

## Box

Inline-level container.

```typc
box(
  width: auto|relative|fraction,
  height: auto|relative,
  baseline: relative,
  fill, stroke, radius, inset, outset, clip,
  none|content,
) -> content
```

```typst
#box(fill: aqua, inset: 4pt)[highlighted]
#box(height: 9pt, image("icon.svg"))
```

---

## Grid

```typc
grid(
  columns: auto|int|relative|fraction|array,
  rows: auto|int|relative|fraction|array,
  gutter: auto|int|relative|fraction|array,
  column-gutter: auto|...array,
  row-gutter: auto|...array,
  inset: relative|array|dictionary|function,
  align: auto|array|alignment|function,
  fill: none|color|gradient|array|tiling|function,
  stroke: none|...function,
  ..content,
) -> content
```

### Track Sizes

- `auto` — fit content
- Fixed: `10pt`, `5em`
- Relative: `50% - 1cm`
- Fractional: `1fr`, `2fr` (distributes remaining space)

```typst
// Simple grid
#grid(
  columns: (60pt, 1fr, 2fr),
  rows: (auto, 60pt),
  gutter: 3pt,
  [Fixed], [1/3 remain], [2/3 remain],
  grid.cell(colspan: 2, [Spanning cell]),
)

// Spread data
#grid(columns: 5, gutter: 5pt, ..range(25).map(str))

// Conditional styling
#grid(
  columns: 5,
  align: center,
  fill: (x, y) => if calc.even(x + y) { silver },
  ..range(15).map(n => [#(n + 1)])
)
```

### Grid Sub-elements

```typc
grid.cell(x, y, colspan, rowspan, fill, align, inset, stroke, content)
grid.hline(y, start, end, stroke, position)
grid.vline(x, start, end, stroke, position)
grid.header(..children)
grid.footer(..children)
```

---

## Stack

Arrange content horizontally or vertically.

```typc
stack(
  dir: direction,         // ltr, rtl, ttb, btt
  spacing: relative|fraction,
  ..content,
) -> content
```

```typst
#stack(dir: ltr, spacing: 1fr, [Left], [Middle], [Right])
#stack(dir: ttb, [Top], [Bottom])
```

---

## Columns

Multi-column layout.

```typst
#columns(2, gutter: 10pt)[
  Content flows across two columns...
]

#show: columns.with(3)   // apply to rest of document

#colbreak()              // force column break
#colbreak(weak: true)    // only if not at top
```

---

## Positioning

### Place

Place content relative to parent container.

```typc
place(
  alignment,              // top, bottom, left, right, center, top+right, etc.
  dx: relative,           // additional horizontal offset
  dy: relative,           // additional vertical offset
  float: bool,            // whether element floats
  scope: str,             // "column" or "parent"
  content,
) -> content
```

```typst
#place(top + right)[Watermark]
#place(center)[Overlay text]
#place(bottom + right, dx: -1em)[Shifted]
```

### Move

Move content without affecting layout.

```typst
#move(dx: 1em, dy: -0.5em)[Shifted text]
```

### Scale

```typst
#scale(150%)[Larger text]
#scale(x: 120%, y: 80%)[Stretched]
```

### Rotate

```typst
#rotate(45deg)[Rotated]
#rotate(45deg, origin: top + left)[Pivot from corner]
```

### Skew

```typst
#skew(dx: 10deg)[Italic-like]
#skew(dx: 10deg, dy: 5deg)
```

### Hide

Hide content without affecting layout.

```typst
#hide[Invisible but takes up space]
```

### Repeat

Repeat content to fill available space.

```typst
#repeat[-]           // fills with dashes
#repeat(gap: 1pt)[.]
```

---

## Layout Measurement

```typc
layout(function) -> content     // access container (width, height)
measure(content, styles) -> size  // measure laid-out size
```

```typst
#layout(size => {
  let half = size.width / 2
  rect(width: half, height: 20pt)
})
```

---

## Length Units

| Unit | Description |
|------|-------------|
| `pt` | Point (1/72 inch) |
| `mm` | Millimeter |
| `cm` | Centimeter |
| `in` | Inch |
| `em` | Relative to current font size |
| `ex` | Relative to x-height |
| `lh` | Line height |
| `%` | Percentage of container |
| `fr` | Fraction of remaining space |

Relative lengths: `50% + 10pt`, `100% - 1cm`
