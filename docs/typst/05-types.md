# Typst Types and Foundations

> All primitive types, their constructors, methods, and usage patterns.

---

## none

A value indicating absence. Invisible when inserted. Default value for uninitialized `let` bindings.

```typst
#let x        // x is none
#none         // invisible
```

Joins with any value silently: `none + "hello"` = `"hello"`

---

## auto

Indicates a smart default. Parameters with `auto` have contextual behavior.

```typst
#set text(dir: auto)    // auto-detect from language
```

---

## bool

`true` or `false`. Supports `not`, `and` (short-circuit), `or` (short-circuit).

```typst
#let flag = true
#not flag
#flag and (1 < 2)
```

---

## int

Whole numbers. Decimal or `0x` hex literals.

```typc
int(value) -> int           // constructor from bool/int/float/str/bytes/decimal
```

---

## float

64-bit floating point.

```typc
float(value) -> float
```

**Constants:** `float.nan`, `float.inf`, `float.neg-inf`
**Methods:** `self.is-nan()`, `self.is-infinite()`, `self.signum()`

---

## str

Unicode string sequence.

### Constructor
```typc
str(value, base: int) -> str
```

### Access Methods
| Method | Returns | Description |
|--------|---------|-------------|
| `self.len()` | int | Length in bytes |
| `self.first(default)` | str | First character |
| `self.last(default)` | str | Last character |
| `self.at(index, default)` | str | Character at index (negative wraps) |
| `self.slice(start, end, count)` | str | Extract substring |

### Search Methods
| Method | Returns | Description |
|--------|---------|-------------|
| `self.contains(pattern)` | bool | str or regex |
| `self.starts-with(pattern)` | bool | str or regex |
| `self.ends-with(pattern)` | bool | str or regex |
| `self.find(pattern)` | int or none | First match position |
| `self.match(pattern)` | dict or none | Match with captures |
| `self.matches(pattern)` | array | All matches |

### Transform Methods
| Method | Description |
|--------|-------------|
| `self.replace(pattern, replacement, count)` | Replace matches |
| `self.trim(pattern, at, repeat)` | Trim whitespace or pattern |
| `self.split(pattern)` | Split into array (default: whitespace) |
| `self.rev()` | Reverse string |
| `self.repeat(count)` | Repeat string |

### Conversion
| Method | Description |
|--------|-------------|
| `self.to-int()` | Parse as integer |
| `self.to-float()` | Parse as float |
| `self.to-decimal()` | Parse as decimal |
| `self.to-bytes()` | Convert to UTF-8 bytes |
| `self.to-datetime(format)` | Parse as datetime |

### Unicode
| Method | Description |
|--------|-------------|
| `self.clusters()` | Grapheme clusters as array |
| `self.codepoints()` | Unicode codepoints as array |
| `str.to-unicode(char)` | Character to codepoint (static) |
| `str.from-unicode(value)` | Codepoint to character (static) |
| `self.normalize(form)` | NFC/NFD/NFKC/NFKD |

---

## content

The core document type. Produced by all markup and most functions.

```typc
content.children() -> array     // Get child elements
content.fields() -> dictionary  // Get all fields
content.func() -> function      // Get creating function
content.has(field) -> bool      // Check field exists
content.at(field, default) -> any  // Get field value
```

Can be concatenated with `+` and multiplied with integers.

---

## array

Sequence of values in parentheses.

```typst
(1, 2, 3)           // array
(1,)                // single-element
()                  // empty
```

### Access
| Method | Description |
|--------|-------------|
| `self.len()` | Number of items |
| `self.first(default)` | First item |
| `self.last(default)` | Last item |
| `self.at(index, default)` | Item at index (negative wraps) |
| `self.slice(start, end, count)` | Subslice |

### Mutation
| Method | Description |
|--------|-------------|
| `self.push(value)` | Add to end |
| `self.pop()` | Remove and return last |
| `self.insert(index, value)` | Insert at index |
| `self.remove(index, default)` | Remove and return |

### Search
| Method | Description |
|--------|-------------|
| `self.contains(value)` | Whether contains |
| `self.find(searcher)` | Find first match |
| `self.position(searcher)` | Find index |

### Transform
| Method | Description |
|--------|-------------|
| `self.filter(test)` | Keep matching |
| `self.map(mapper)` | Transform each |
| `self.fold(init, folder)` | Reduce |
| `self.enumerate(start)` | Get (index, value) pairs |
| `self.zip(..others)` | Zip arrays together |
| `self.flatten()` | Flatten nested |
| `self.rev()` | Reverse |
| `self.sorted(key)` | Return sorted |
| `self.join(separator, last)` | Join into string |
| `self.sum(default)` | Sum items |
| `self.product(default)` | Product of items |
| `self.any(test)` | Any match? |
| `self.all(test)` | All match? |
| `self.chunks(n)` | Split into chunks |
| `self.windows(n)` | Sliding windows |
| `self.split(at)` | Split at delimiter |
| `self.intersperse(sep)` | Place sep between items |

---

## dictionary

Map from string keys to values.

```typst
(name: "Typst", born: 2019)
(:)                 // empty
```

Access: `dict.key` or `dict.at("key")`
Add/modify: `dict.key = value`

| Method | Description |
|--------|-------------|
| `self.len()` | Number of pairs |
| `self.at(key, default)` | Get value |
| `self.insert(key, value)` | Insert pair |
| `self.remove(key, default)` | Remove and return |
| `self.keys()` | All keys |
| `self.values()` | All values |
| `self.pairs()` | All (key, value) tuples |

---

## function

```typc
function.with(..args) -> function       // pre-bind arguments
function.where(..fields) -> selector    // filter elements
```

Element functions (like `heading`, `table`) can be used in set/show rules and selectors.

---

## arguments

Captured function arguments via `..sink`.

```typc
arguments.pos() -> array        // positional args
arguments.named() -> dictionary // named args
arguments.at(key, default)      // access by index or name
```

---

## calc Module

Constants: `calc.pi`, `calc.tau`, `calc.e`, `calc.inf`

### General
| Function | Description |
|----------|-------------|
| `calc.abs(x)` | Absolute value |
| `calc.pow(base, exp)` | Power |
| `calc.exp(x)` | e^x |
| `calc.sqrt(x)` | Square root |
| `calc.root(radicand, index)` | Nth root |
| `calc.log(x, base)` | Logarithm (base 10 default) |
| `calc.ln(x)` | Natural log |
| `calc.deg(rad)` | Radians to degrees |
| `calc.rad(deg)` | Degrees to radians |

### Trigonometric
`sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2(x, y)`, `sinh`, `cosh`, `tanh`

### Rounding
`floor`, `ceil`, `trunc`, `fract`, `round(value, digits)`

### Combinatorics
`factorial`, `perm(base, numbers)`, `binom(n, k)`

### Number Theory
`gcd`, `lcm`, `clamp(value, min, max)`, `rem`, `rem-euclid`, `quo`, `mod`, `odd`, `even`

### Aggregation
`min(..values)`, `max(..values)`, `sum(..values)`, `product(..values)`, `norm(p, ..values)`

---

## Other Types

| Type | Key Info |
|------|----------|
| **bytes** | Binary data: `bytes(string)`, `bytes(1, 2, 3)`, `.len()`, `.at()`, `.slice()` |
| **datetime** | `datetime(year, month, day, hour, minute, second)`, `datetime.today()`, `.display(format)`, `.year()`, `.month()`, `.day()`, `.weekday()`, `.ordinal()`, `.iso()` |
| **duration** | `duration(weeks, days, hours, minutes, seconds)`, `.seconds()`, `.minutes()`, etc. |
| **decimal** | Fixed-point precise arithmetic |
| **regex** | `regex(pattern)` for string matching |
| **version** | `version(major, minor, patch, ..)`, `.components()`, `.at(index)` |
| **symbol** | Unicode symbol with variants: `sym.arrow.r`, `sym.alpha` |
| **label** | `<name>` — attach to elements for referencing |
| **selector** | Filter for elements: `heading.where(level: 1)`, `.or()`, `.and()`, `.before()`, `.after()` |
| **location** | Document location: `.page()`, `.position()`, `.page-numbering()` |
| **module** | Imported file/package contents |
| **color** | See [Visualize](09-visualize.md) |
| **gradient** | See [Visualize](09-visualize.md) |
| **stroke** | See [Visualize](09-visualize.md) |
