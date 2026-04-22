# Typst Cheat Sheet

> Quick reference for the most common syntax and patterns.

---

## File Structure

```typst
// Imports at top
#import "@preview/package:1.0.0": func

// Document metadata
#set document(title: "Title", author: ("Name",))

// Global styling
#set page(margin: 1in)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: true, first-line-indent: 1em)
#set heading(numbering: "1.")

// Content starts
= Title

Body text with *bold* and _italic_.
```

---

## Common Markup (One-Liners)

| Want | Write |
|------|-------|
| Bold | `*text*` |
| Italic | `_text_` |
| Code inline | `` `code` `` |
| Code block | ` ```lang\ncode\n``` ` |
| Heading | `= Title` / `== Section` |
| Bullet list | `- item` |
| Numbered list | `+ item` |
| Definition list | `/ Term: definition` |
| Link | `https://url` or `#link("url")` |
| Label | `= Heading <label>` |
| Reference | `@label` |
| Footnote | `#footnote[text]` |
| Line break | `\\` |
| Math inline | `$x^2$` |
| Math block | `$ x^2 $` |
| Comment | `// line` or `/* block */` |
| Horizontal rule | `#line(length: 100%)` |
| Non-breaking space | `~` |
| Em dash | `---` |
| En dash | `-` |

---

## Common Set Rules

```typst
// Page
#set page(paper: "a4", margin: 1in)
#set page(header: [Header], footer: context [#h(1fr)#counter(page).display()])

// Text
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set text(fill: navy)

// Paragraph
#set par(justify: true, first-line-indent: 1em, spacing: 0.65em)

// Heading
#set heading(numbering: "1.a)")

// List
#set list(marker: ([•], [‣], [–]))
#set enum(numbering: "a)")
```

---

## Common Show Rules

```typst
// Style all links
#show link: underline
#show link: set text(blue)

// Custom headings
#show heading.where(level: 1): it => [
  #pagebreak(weak: true)
  #v(2em)
  #it
  #v(1em)
]

// Custom figures
#show figure.where(kind: table): set figure.caption(position: top)

// Number equations
#set math.equation(numbering: "(1)")

// Redact strike
#show strike: set text(red)
```

---

## Functions

```typst
// Define
#let greet(name) = [Hello, #name!]
#let box(text, fill: yellow) = rect(fill: fill, inset: 4pt)[#text]

// With content argument
#let important(it) = [
  #set text(weight: "bold")
  #rect(fill: red.lighten(80%), inset: 8pt, #it)
]
#important[This is critical!]

// Argument sink
#let sum(..nums) = nums.pos().sum()
#sum(1, 2, 3, 4)    // 10
```

---

## Variables & Control Flow

```typst
#let x = 5
#let y = if x > 0 { "positive" } else { "non-positive" }

#for i in range(5) { [#i] }
#for (k, v) in dict { [#k = #v \n] }

#let n = 1
#while n < 100 { n *= 2; (n, ) }

// Array operations
#let nums = (3, 1, 4, 1, 5)
#nums.sorted()        // (1, 1, 3, 4, 5)
#nums.map(x => x * 2) // (6, 2, 8, 2, 10)
#nums.filter(x => x > 2)  // (3, 4, 5)
#nums.join(", ")       // "3, 1, 4, 1, 5"
#nums.sum()            // 14

// String operations
#"hello world".split()       // ("hello", "world")
#"hello world".split(" ")    // ("hello", "world")
#"abc".at(1)                 // "b"
#"abc".rev()                 // "cba"
```

---

## Math Quick Reference

```typst
$x^2$                    // superscript
$x_i$                    // subscript
$x_i^j$                  // both
$1/2$                    // fraction
$frac(a^2, 2)$           // explicit fraction
$sqrt(x)$                // square root
$root(3, x)$             // nth root
$sum_i^n$                // summation with limits
$integral_a^b$           // integral with bounds
$mat(1, 2; 3, 4)$        // matrix
$binom(n, k)$            // binomial
$cases(1 "if" x > 0, 0 "otherwise")$   // piecewise
$lr((x/y))$              // sized parens
$abs(x)$                 // absolute
$floor(x)$               // floor
$ceil(x)$                // ceiling
$norm(v)$                // norm
$arrow(x)$               // arrow accent
$x hat$                  // hat accent
$cal(A)$                 // calligraphic
$bb(R)$                  // blackboard bold
$bold(x)$                // bold in math

// Alignment
$
  f(x) &= x^2 + 1 \\
       &= 2x
$
```

---

## Layout Patterns

```typst
// Center content
#align(center)[Centered]

// Push content to edges
#h(1fr) between #h(1fr) edges

// Side-by-side
#grid(columns: 2, [Left], [Right])
#stack(dir: ltr, [A], h(1fr), [B])

// Box with background
#rect(fill: silver, inset: 8pt, radius: 4pt)[Content]

// Page break
#pagebreak()
#pagebreak(weak: true)
#pagebreak(to: "odd")

// Two columns
#show: columns.with(2)
#colbreak()     // column break

// Float figure
#place(top, float: true)[
  #figure(image("fig.png"), caption: [...])
]
```

---

## Context & Introspection

```typst
// Current page number
#context counter(page).display("1")

// Custom header with current chapter
#set page(header: context {
  let h = query(heading.where(level: 1))
    .filter(h => h.location().page() <= here().page())
    .last()
  if h != none { h.body }
  h(1fr)
  counter(page).display("1")
})

// Query document
#context query(heading.where(level: 1)).len()

// State
#let s = state("key", 0)
#s.update(5)
#context s.get()
```

---

## Colors & Fills

```typst
// Named colors
#rect(fill: red)
#rect(fill: navy)
#rect(fill: luma(200))          // grayscale

// Custom colors
#rect(fill: rgb("#1E90FF"))
#rect(fill: cmyk(0%, 100%, 50%, 0%))
#text(fill: gradient.linear(red, blue))[Gradient]

// Lighten / darken
#rect(fill: red.lighten(50%))
#rect(fill: blue.darken(30%))

// Stroke
#rect(stroke: 2pt + red)
#rect(stroke: (paint: red, thickness: 2pt, dash: "dashed"))
```

---

## Data Loading

```typst
#let data = json("data.json")
#let csv = csv("data.csv")
#let config = yaml("config.yaml")
#let text = read("file.txt")
```

---

## Common Errors & Solutions

| Error | Solution |
|-------|----------|
| `expected content, found integer` | Wrap in `[]` or use `#(expr)` |
| `unknown variable` | Check spelling, import, or scope |
| `expected expression` | Missing `#` before code in markup |
| `content does not contain field` | Use `.fields()` to inspect |
| `cannot mutate` | Some values are immutable; use `state()` |
| `context is not available` | Wrap in `#context { .. }` |
| `layout did not converge` | Excessive state/counter dependencies |

---

## Operator Precedence (high → low)

```
7:  -x  +x
6:  *  /
5:  +  -
4:  ==  !=  <  <=  >  >=  in  not in
3:  not  and
2:  or
1:  =  +=  -=  *=  /=
```

---

## Special Values

| Value | Meaning |
|-------|---------|
| `none` | Absent/empty value |
| `auto` | Smart default |
| `true` / `false` | Booleans |
| `inf` / `float.inf` | Infinity |
| `nan` / `float.nan` | Not a number |
| `end` / `start` | Alignment aliases |
| `ltr` / `rtl` / `ttb` / `btt` | Directions |
