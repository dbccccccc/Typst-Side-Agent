# Typst Syntax Basics

> Core syntax: modes, literals, comments, identifiers, paths, operators, escape sequences.

---

## Three Modes

| Mode | Default In | Enter | Example |
|------|-----------|-------|---------|
| **Markup** | Top-level document | (default) | `Hello *world*` |
| **Code** | Code blocks, after `#` | Prefix with `#` | `#let x = 5` |
| **Math** | Inside `$...$` | Surround with `$` | `$x^2 + y^2 = z^2$` |

- After entering code mode with `#`, further expressions in the same context don't need additional `#` unless switching back to markup/math in between.
- To force end a code expression: use `;`
- Escape literal `#` or `;` with backslash: `\#`, `\;`

### Mode Switching Examples

```typst
#let name = [*Typst!*]      // code mode → content block inside
#(1 + 2)                     // parentheses needed for binary expressions
$name                         // variable access in markup
$x^2$                         // math inline
$ x^2 $                      // math block (spaces around content)
```

---

## Literals

| Type | Syntax | Examples |
|------|--------|----------|
| **none** | `none` | `none` |
| **auto** | `auto` | `auto` |
| **bool** | `true`, `false` | `true`, `false` |
| **int** | Decimal, hex with `0x` | `42`, `-7`, `0xff` |
| **float** | Decimal with `.` or exponent | `3.14`, `-0.5`, `1e5`, `1e-10` |
| **length** | Number + unit | `2pt`, `3mm`, `1cm`, `1in`, `1em`, `1ex`, `1lh` |
| **angle** | Number + `deg` or `rad` | `90deg`, `1rad` |
| **ratio** | Number + `%` | `50%`, `100%` |
| **fraction** | Number + `fr` | `1fr`, `2fr` |
| **relative** | Length + ratio | `50% + 10pt`, `100% - 5pt` |
| **string** | Double quotes with escapes | `"hello"`, `"line\n two"`, `"\u{1f600}"` |
| **label** | Angle brackets | `<intro>`, `<fig:tiger>` |
| **raw** | Backticks | `` `code` `` (inline), `` ```code``` `` (block) |

### String Escape Sequences

| Sequence | Meaning |
|----------|---------|
| `\\` | Backslash |
| `\"` | Quote |
| `\n` | Newline |
| `\r` | Carriage return |
| `\t` | Tab |
| `\u{1f600}` | Unicode codepoint (hex) |

---

## Comments

```typst
// Single-line comment

/* Multi-line
   comment */
```

---

## Identifiers

- Can contain: letters, numbers, hyphens (`-`), underscores (`_`)
- Must start with: letter or underscore
- Based on Unicode Standard Annex #31 with extensions
- **Convention**: Use kebab-case for multi-word identifiers (e.g., `top-edge`, `line-height`)

```typst
#let kebab-case = [Using hyphens]
#let _schön = "😊"
#let π = calc.pi
```

---

## Paths

**Relative path** (from current file):
```typst
#image("images/logo.png")
```

**Absolute path** (from project root):
```typst
#image("/assets/logo.png")
```

- Default project root: parent directory of the main Typst file
- CLI flag `--root` to set a custom root
- In web app: the project directory is the root

---

## Operators

### Unary

| Op | Effect | Prec |
|----|--------|------|
| `-` | Negation | 7 |
| `+` | No-op | 7 |
| `not` | Logical NOT | 3 |

### Binary (by precedence, high to low)

| Prec | Operators |
|------|-----------|
| 6 | `*` (mul), `/` (div) |
| 5 | `+` (add), `-` (sub) |
| 4 | `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not in` |
| 3 | `and` |
| 2 | `or` |
| 1 | `=`, `+=`, `-=`, `*=`, `/=` (assignment) |

- Higher precedence = binds stronger
- Modulo (`%`) has no syntax; use `calc.mod(x, y)`

---

## Special Characters / Delimiters

| Char | Usage |
|------|-------|
| `#` | Enter code mode |
| `;` | Statement separator |
| `{ }` | Code block |
| `[ ]` | Content block |
| `( )` | Grouping, function calls, arrays, dicts |
| `=>` | Closure/function body |
| `..` | Rest/spread operator |
| `,` | Argument/item separator |
| `:` | Key-value separator |
| `.` | Field access, method call |
| `_` | Ignored binding |
| `<label>` | Label attachment |
| `@preview/pkg:0.1.0` | Package import syntax |
