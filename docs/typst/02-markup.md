# Typst Markup

> Markup mode elements: paragraphs, headings, lists, emphasis, links, labels, raw text.

---

## Paragraphs

- Paragraphs are separated by **blank lines** (one or more empty lines)
- A backslash `\` at end of line creates a forced line break (visible as `\`)
- Use `#parbreak()` for explicit paragraph breaks in code

```typst
This is the first paragraph.

This is the second paragraph. It contains
a forced line break here.\
and continues on the next line.
```

### Paragraph Properties (via `#set par(...)`)

| Parameter | Type | Description |
|-----------|------|-------------|
| `leading` | length | Line spacing |
| `spacing` | length | Paragraph spacing |
| `justify` | bool | Whether to justify text |
| `linebreaks` | `"simple"` or `"optimized"` | Line breaking algorithm |
| `first-line-indent` | length | Indent of first line |
| `hanging-indent` | length | Hanging indent |

```typst
#set par(justify: true, first-line-indent: 1em, spacing: 0.65em)
```

---

## Headings

```typst
= Top-level heading
== Subsection
=== Sub-subsection
==== Level 4
```

### Heading Parameters

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

| Parameter | Description |
|-----------|-------------|
| `numbering` | Pattern like `"1."`, `"I."`, `"1.a.i"`, or a function |
| `outlined` | Include in table of contents |
| `bookmarked` | Bookmark in PDF |
| `supplement` | Prefix for references (e.g., "Section") |

```typst
#set heading(numbering: "1.a)")
= Introduction <intro>

// Reference later: @intro
```

---

## Emphasis

| Syntax | Element | Function |
|--------|---------|----------|
| `*strong*` | **Bold** | `#strong[content]` |
| `_emphasis_` | *Italic* | `#emph[content]` |
| `` `raw` `` | `Code` | `#raw("code")` |

```typst
This is *bold* and _italic_.
Use #strong[red text] with a show rule: #show strong: set text(red)
```

---

## Lists

### Bullet List

```typst
- First item
- Second item
  - Nested item
  - Another nested
- Third item
```

**Parameters:** `list(tight, marker, indent, body-indent, spacing, ..children)`
- `marker`: bullet symbol(s), default `([•], [‣], [–])`

### Numbered List (Enum)

```typst
+ First item
+ Second item
++ Continues numbering

// Or with explicit numbers:
2. Second
5. Fifth
+ Continues
```

**Parameters:** `enum(tight, numbering, start, full, reversed, indent, body-indent, spacing, number-align, ..children)`
- `numbering`: pattern like `"1."`, `"a)"`, `"I."`

### Definition List (Terms)

```typst
/ Term: Definition text
/ Another term: Its definition
  that can span multiple lines.
```

**Parameters:** `terms(tight, separator, indent, hanging-indent, spacing, ..children)`

---

## Links and References

### Automatic Links

```typst
https://typst.app/          // auto-detected URL
```

### Manual Links

```typc
link(dest: str|label|location, body: content) -> content
```

```typst
#link("https://example.com")
#link("https://example.com")[Click here]
```

### Labels and References

Attach a label to any element, then reference it:

```typst
= Introduction <intro>
@intro                          // Reference
@intro[Section]                 // Reference with custom supplement
#ref(<intro>)                   // Explicit ref function
#ref(<intro>, form: "page")     // Page number reference
```

**Referenceable elements:** headings, figures, equations, footnotes

---

## Raw Text (Code Blocks)

### Inline

```typst
Use `print(1)` to output.
```

### Block

```typst
```python
def hello():
    return "world"
```
```

**Parameters:** `raw(text, block: false, lang: none, align, inset, fill, stroke, radius, theme)`

| Parameter | Description |
|-----------|-------------|
| `block` | `true` for block mode |
| `lang` | Language for syntax highlighting |
| `theme` | Color theme for highlighting |

---

## Smart Quotes

```typst
'Single quotes'   → 'Single quotes'
"Double quotes"   → "Double quotes"
```

Language-aware via `#set text(lang: "de")` etc.

---

## Other Markup Elements

### Footnotes

```typst
Text with a footnote#footnote[This is the footnote text.]
```

### Line Break

```typst
# line break in paragraph: \
# linebreak()       // explicit function
```

### Horizontal Rule

```typst
#line(length: 100%)
#hr()               // shorthand
```

---

## Element Summary Table

| Markup | Shortcut For |
|--------|-------------|
| Blank line | `#parbreak()` |
| `*text*` | `#strong[text]` |
| `_text_` | `#emph[text]` |
| `` `text` `` | `#raw("text")` |
| `https://...` | `#link("https://...")` |
| `<label>` | `#label("label")` |
| `@label` | `#ref(<label>)` |
| `= Heading` | `#heading[Heading]` |
| `- item` | `#list[Item]` |
| `+ item` | `#enum[Item]` |
| `/ Term: def` | `#terms.item[Term][def]` |
| `\` | `#linebreak()` |
| `/* ... */`, `// ...` | Comments |
| `"text"` | Smart quotes |
| `~` | Non-breaking space |
| `---` | Em dash |
| `-` | En dash |
