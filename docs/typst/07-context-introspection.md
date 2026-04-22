# Typst Context & Introspection

> Context system, counters, states, queries, and document introspection.

---

## Context

The `context` keyword creates expressions that react to their document location.

```typst
#context text.lang          // current text language
#context text.size          // current text size
#context text.font          // current font
```

### Key Properties

- Context expressions are **opaque** — you cannot directly access their result outside placement
- They may be evaluated **zero, one, or multiple times** depending on placement
- Everything depending on contextual data must be **inside** the context block
- Context is also established **implicitly** in show rules and numberings

### Style Context

Access set rule values via element function fields:

```typst
#set text(lang: "de")
#context text.lang      // "de"

#set heading(numbering: "1.")
#context heading.numbering    // "1."
```

### Location Context

Know where you are in the document:

```typst
#context {
  let headings = query(heading)
  [Found #headings.len() headings.]
}
```

### Nested Contexts

Context blocks can be nested. Inner context takes precedence:

```typst
#set text(lang: "de")
#context [
  #set text(lang: "fr")
  #text.lang        // "fr" — innermost
]
```

### Compiler Iterations

Typst compiles documents up to 5 times to resolve context. Warning `"layout did not converge within 5 attempts"` signals excessive iteration.

---

## Counter

Count pages, elements, or custom things.

```typc
counter(key: str|element|function) -> counter
```

**Built-in counters:**
- `counter(page)` — page numbers
- `counter(heading)` — heading numbers
- `counter(figure)` — figure numbers
- `counter(math.equation)` — equation numbers
- `counter(footnote)` — footnote numbers
- `counter(figure.where(kind: table))` — table figures only

### Methods

| Method | Description |
|--------|-------------|
| `counter.get()` | Current value as array of integers |
| `counter.display(numbering, both)` | Display with numbering pattern |
| `counter.at(selector)` | Value at specific location |
| `counter.final()` | Final value after all pages |
| `counter.step(level: 1)` | Increment by 1 |
| `counter.update(value or function)` | Set to value or apply function |

### Examples

```typst
// Display current page
#context counter(page).display("1")

// Step heading counter manually
#counter(heading).step()
#counter(heading).update(3)
#counter(heading).update(n => n * 2)

// Get value at label
#context counter(heading).at(<intro>)
```

---

## State

Stateful variables that persist across the document.

```typc
state(key: str, init: any) -> state
```

### Methods

| Method | Description |
|--------|-------------|
| `state.get()` | Current value |
| `state.at(selector)` | Value at location |
| `state.final()` | Final value |
| `state.update(value or function)` | Update value |

### Example

```typst
#let s = state("my-state", 0)

#context s.get()      // 0
#s.update(5)
#context s.get()      // 5
#s.update(n => n + 1)
#context s.get()      // 6
```

---

## Query

Find elements in the document.

```typc
query(target: label|selector|location|function) -> array
```

Requires `context`.

```typst
// All headings
#context query(heading)

// Headings at level 1
#context query(heading.where(level: 1))

// Elements before current position
#context query(selector(heading).before(here()))

// By label
#context query(<intro>)

// Build custom TOC
#context {
  let chapters = query(heading.where(level: 1, outlined: true))
  for chapter in chapters {
    let loc = chapter.location()
    let nr = numbering(loc.page-numbering(), ..counter(page).at(loc))
    [#chapter.body #h(1fr) #nr \]
  }
}
```

---

## Locate

Get the location of a specific element.

```typc
locate(selector: label|selector|location) -> location
```

```typst
#context locate(<intro>).position()    // { page: 1, x: 0pt, y: 0pt }
```

---

## Here

Get current document location.

```typc
here() -> location
```

```typst
#context [
  Current page: #here().page()
  Position: #here().position()
]
```

---

## Metadata

Embed invisible queryable data.

```typc
metadata(value: any) -> content
```

```typst
#metadata("chapter1") <chapter-marker>

// Query elsewhere
#context {
  query(<chapter-marker>).first().value
}

// CLI: typst query doc.typ "<chapter-marker>" --field value
```

---

## Location Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `location.page()` | int | Physical page number (1-based) |
| `location.position()` | dictionary | `{ page: int, x: length, y: length }` |
| `location.page-numbering()` | str | Page numbering pattern at location |

---

## Locatable Elements

Can be queried: `heading`, `figure`, `table`, `equation`, `raw`, `underline`, `overline`, `strike`, `highlight`, `metadata`, `image`, `footnote`, `list`, `enum`, `terms`

---

## Pattern: Chapter-Aware Headers

```typst
#set page(header: context {
  let chapters = query(heading.where(level: 1))
  let current = here().page()
  let active = chapters.filter(h => h.location().page() <= current).last()
  if active != none {
    active.body
    h(1fr)
    counter(page).display("1")
  }
})
```
