# Typst Styling

> Set rules, show rules, selectors, and the styling system.

---

## Set Rules

Configure default properties of elements. Written as `set` + function call.

```typst
// Syntax
set function(param: value)
#set function(param: value)     // in markup
```

- Only optional parameters can be set
- Top-level: stays in effect until end of file
- Inside a block: only in effect until end of block

```typst
#set heading(numbering: "1.")
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, first-line-indent: 1em)
#set page(margin: 1in)
#set enum(numbering: "a)")
```

### Scoping with Content Blocks

```typst
This list uses default marker:
- Default

#[
  #set list(marker: [--])
  - Dash style   // only within this block
]

- Back to default
```

### Conditional Set (Set-If)

```typst
#let task(body, critical: false) = {
  set text(red) if critical
  [- #body]
}
#task(critical: true)[Food today?]
#task(critical: false)[Work deadline]
```

---

## Show Rules

Redefine how elements appear. More powerful than set rules.

### Show-Set Rule

```typst
// Syntax
show selector: set function(param: value)

#show heading: set text(navy)
#show "Project": smallcaps
#show link: underline
```

### Show with Function

```typst
// Syntax
show selector: it => { .. }

#show heading: it => [
  #set text(navy)
  #set align(center)
  #it.body
]

= Dragon
With a base health of 15...
```

The function receives the matched element and returns replacement content.

### String/Content Substitution

```typst
#show "Project": smallcaps
#show "badly": "great"

We started Project in 2019.     // "Project" becomes smallcaps
Project is progressing badly.   // "badly" becomes "great"
```

---

## Selectors

Define which elements a show rule targets.

| Selector Form | Syntax | Matches |
|--------------|--------|---------|
| **Element function** | `show heading: ..` | All instances of element type |
| **Everything** | `show: rest => ..` | All content after the rule |
| **Literal text** | `show "Text": ..` | Exact text match |
| **Regex** | `show regex("\w+"): ..` | Pattern match |
| **Field filter** | `show heading.where(level: 1): ..` | Elements with matching fields |
| **Label** | `show <intro>: ..` | Elements with label |

```typst
// Element function
#show heading: set text(navy)
#show heading.where(level: 1): set text(size: 20pt)

// Everything
#show: rest => [
  #set text(font: "Georgia")
  #rest
]

// Text literal
#show "Project": smallcaps

// Regex
#show regex("\d+"): set text(red)     // all numbers red

// Label
#show <important>: set text(weight: "bold", fill: red)

= Important Heading <important>
```

### Selector Combinators

```typst
heading.where(level: 1).or(heading.where(level: 2))
heading.where(level: 1).and(outlined: true)
selector(heading).before(here())
selector(heading).after(here())
```

---

## Show Rule Precedence

- More specific selectors override less specific ones
- Later rules override earlier ones of equal specificity
- Show-set rules and show-with-function rules can coexist

---

## Common Styling Patterns

### Document Font Setup

```typst
#set text(
  font: "New Computer Modern",
  size: 11pt,
  lang: "en",
  fallback: false,
)
```

### Custom Heading Style

```typst
#show heading.where(level: 1): it => [
  #pagebreak(weak: true)
  #set text(size: 24pt, weight: "bold")
  #block(above: 2em, below: 1em)[
    #counter(heading).display("1.") #it.body
  ]
]
```

### Custom Figure Style

```typst
#show figure.where(kind: table): set figure.caption(position: top)
#show figure: it => [
  #v(1em)
  #it.body
  #v(0.5em)
  #it.caption
  #v(1em)
]
```

### Link Styling

```typst
#show link: underline
#show link: it => [
  #set text(fill: blue)
  #underline(it)
]
```
