# Typst Scripting

> Variables, functions, control flow, blocks, modules, packages, imports.

---

## Code Expressions

Code is introduced with `#` in markup. Within code blocks and expressions, expressions flow naturally.

```typst
#let x = 5              // variable binding
#(1 + 2)                // parenthesized expression
#emph[Hello]            // function call
#values.len()           // method call
```

---

## Blocks

### Code Block `{ ... }`

Multiple expressions where one is expected. Values are **joined**.

```typst
{
  let x = 1
  let y = 2
  x + y        // returns 3
}
```

- Separated by newlines or semicolons
- Expressions without useful output (like `let`) yield `none`, which joins silently
- Last expression value is the block's value (unless ended with `;`)

### Content Block `[ ... ]`

```typst
#let greeting = [*Hello* _world_!]
#greeting

// Trailing content block = function argument
#emph[Hello]        // same as emph("Hello")
#list[A][B][C]      // same as list("A", "B", "C")
```

- Results in a value of type `content`
- Can contain arbitrary markup
- An arbitrary number of content blocks can be passed as trailing arguments to functions

### Nested Blocks

```typst
#{
  let a = [from]
  let b = [*world*]
  [hello] + a + [ the ] + b   // joined content
}
```

---

## Bindings

### Let Bindings

```typst
#let name = "Typst"
#let value          // initialized as none
#let x = 1
#let y = 2
```

- Variables accessible for the rest of the containing block (or file)
- Identifiers may contain `-` but cannot start with `-`

### Destructuring

```typst
// Array destructuring
#let (x, y) = (1, 2)
#let (a, ..rest) = (1, 2, 3, 4)
#let (_, y, _) = (1, 2, 3)        // ignore with _

// Dictionary destructuring
#let (name: n, age: a) = (name: "Ada", age: 36)

// In function args
#left.zip(right).map(((a, b)) => a + b)

// In assignments (swapping)
#(a, b) = (b, a)
```

---

## Functions

### Defining Functions

```typst
#let add(a, b) = a + b
#let greet(name: "World") = [Hello, #name!]
#let alert(body, fill: red) = {
  set text(white)
  set align(center)
  rect(fill: fill, inset: 8pt, radius: 4pt, [*Warning:* \ #body])
}
```

- Positional parameters: listed first
- Named parameters: with defaults (`name: default`)
- Argument sink: `..args` captures excess arguments
- Body parameter: content block passed as trailing argument

### Argument Sinks and Spreading

```typst
#let format(title, ..authors) = {
  let by = authors.pos().join(", ", last: " and ")
  [*#title* \\ _Written by #by;_]
}
#format("ArtosFlow", "Jane", "Joe")

// Spreading
#let nums = (2, 3, 5)
#calc.min(..nums)
#let dict = (fill: blue)
#text(..dict)[Hello]
```

### Closures (Anonymous Functions)

```typst
#let square = (x) => x * x
#(1, 2, 3).map(x => x * x)
#(1, 2, 3).filter(x => x > 1)
```

### Function Methods

| Method | Description |
|--------|-------------|
| `f.with(..args)` | Create function with pre-bound arguments |
| `f.where(..fields)` | Create selector filtering by field values |

```typst
#let bold-red = text.with(weight: "bold", fill: red)
#bold-red[Hello]
```

### Return

```typst
#let safe-div(a, b) = {
  if b == 0 { return 0 }
  a / b
}
```

---

## Control Flow

### If / Else

```typst
#if x > 0 [Positive] else [Non-positive]
#if x > 0 { positive() } else if x < 0 { negative() } else { zero() }

// With code blocks
#let result = if x > 0 {
  "positive"
} else {
  "non-positive"
}
```

### For Loop

```typst
#for item in items {
  process(item)
}

#for (key, value) in dict { .. }
#for letter in "abc" { .. }          // iterates grapheme clusters
#for byte in bytes("abc") { .. }     // iterates bytes (int 0-255)
#for i in range(10) { .. }

// With index
#for (i, item) in items.enumerate() { .. }
```

### While Loop

```typst
#let n = 2
#while n < 10 {
  n = (n * 2) - 1
  (n,)
}
```

### Break and Continue

```typst
#for letter in "abc nope" {
  if letter == " " { break }
  letter
}

#for i in range(10) {
  if calc.even(i) { continue }
  i  // only odd numbers
}
```

---

## Fields and Methods

### Field Access

```typst
#let it = [Hello *World*]
#it.body.text          // nested field access
```

### Method Calls

```typst
#let values = (1, 2, 3, 4)
#values.len()
#values.map(x => x * 2)
#"a, b, c".split(", ").join[---]
```

---

## Modules and Imports

### Include

Evaluates a file and returns its content:

```typst
#include "chapter1.typ"
```

### Import

```typst
import "bar.typ"              // import as 'bar' (filename w/o extension)
import "bar.typ" as baz       // rename
import "bar.typ": a, b        // import specific items
import "bar.typ": *           // import all items
import "bar.typ": a as one    // rename items
import "bar.typ": a, b, c     // multiple items
```

Items must be defined in the imported file via `let` bindings.

### Packages

```typst
import "@preview/cetz:0.3.1"
import "@preview/cetz:0.3.1": canvas, draw
import "@preview/cetz:0.3.1" as cetz
```

- `@preview/` — community packages on Typst Universe
- Format: `@namespace/name:version`

---

## Assert and Panic

```typst
#assert(1 < 2, message: "math broke")
#assert.eq(a, b)
#assert.ne(a, b)
#panic("something went wrong")
```

---

## Eval

Evaluate a string as Typst code:

```typst
#eval("1 + 2", mode: "code")       // returns 3
#eval("*hello*", mode: "markup")   // returns bold "hello"
#eval("x^2", mode: "math")         // returns math content
```

---

## Key Keywords Summary

| Keyword | Usage |
|---------|-------|
| `let` | Variable/function bindings |
| `if` / `else` / `else if` | Conditionals |
| `for` | Iteration |
| `while` | Conditional iteration |
| `break` | Exit loop |
| `continue` | Skip iteration |
| `return` | Return from function |
| `include` | Include file content |
| `import` | Import module/items |
| `as` | Rename in import |
| `context` | Context-aware expression |
| `set` | Set rule |
| `show` | Show rule |
| `none` / `auto` / `true` / `false` | Special values |
| `not` / `and` / `or` / `in` | Operators |
