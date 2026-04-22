# Typst Math Mode

> Mathematical typesetting: equations, fractions, attachments, matrices, symbols, styles.

---

## Entering Math Mode

| Form | Syntax | Example |
|------|--------|---------|
| **Inline math** | `$...$` (no spaces inside) | `$x^2$` |
| **Block math** | `$ ... $` (spaces inside) | `$ x^2 + y^2 = z^2 $` |
| **Numbered equation** | `$$ ... $$` (Typst 0.13+) or `math.equation(...)` | `$$ E = mc^2 $$` |

```typst
The Pythagorean theorem: $x^2 + y^2 = z^2$ is inline.

$ x^2 + y^2 = z^2 $  // This is a block.

// Numbered equation:
$ E = mc^2 $ <einstein>
```

---

## Variables and Text

| Syntax | Meaning | Example |
|--------|---------|---------|
| Single letter | Variable | `$x$, $A$, ` (italic) |
| Multiple letters | Text operator | `$area = pi r^2$` |
| `"text"` | Verbatim text in math | `$"area" = pi dot "radius"^2$` |
| `#x` | Code variable in math | `#let x = 5; $#x < 17$` |
| `cal(A)` | Calligraphic | `$cal(A)$` |
| `bb(R)` | Blackboard bold | `$bb(R)$` |

---

## Basic Constructs

### Attachments (Subscripts & Superscripts)

```typst
$x_i$           // subscript
$x^2$           // superscript
$x_i^j$         // both
$x_i_j$         // nested subscripts
$x^2^3$         // nested superscripts
$sum_i^n$       // natural limits
$lim_x$         // limit-style
$integral_a^b$  // integral bounds
```

### Fractions

```typst
$1/2$                    // simple
$(a + b) / (c + d)$     // grouped
$frac(a^2, 2)$          // explicit function
$a / b / c$             // nested fractions
```

### Roots

```typst
$sqrt(x)$               // square root
$sqrt(3, x)$            // nth root (or $root(3, x)$)
```

### Delimiter Matching

```typst
$lr((x / y))$           // auto-sized parens
$lr[{x / y}])$          // auto-sized brackets
$abs(x)$                // absolute value
$norm(v)$               // norm
$floor(x)$              // floor
$ceil(x)$               // ceiling
$round(x)$              // round
```

---

## Alignment & Line Breaks

```typst
$
  sum_(k=0)^n k
    &= 1 + dots + n \\
    &= (n(n+1)) / 2
$
```

- `&` = alignment point (alternates right-aligned / left-aligned columns)
- `&&` = double alignment (skips back to right-aligned)
- `\` = line break

---

## Matrices

```typst
$mat(1, 2; 3, 4)$                         // 2x2 matrix
$mat(1, 2, 3; 4, 5, 6)$                   // 2x3 matrix
$mat(delim: "[", 1, 2; 3, 4)$             // custom delimiter
$mat(augment: #2, 1, 0, 2; 0, 1, 3)$      // augmented matrix
```

- Rows separated by `;`
- Columns separated by `,`
- `delim`: `"("`, `"["`, `"{"`, `"|"`, `"||"`
- `augment: #n` = draw line after nth column

### Binomial

```typst
$binom(n, k)$
```

### Cases (Piecewise)

```typst
$f(x) = cases(
  1 "if" x > 0,
  0 "if" x <= 0,
)$
```

---

## Accents

```typst
$x tilde$           // tilde
$x hat$             // hat
$x bar$             // bar
$x vec$             // vector arrow
$x dot$             // dot
$x dot.double$      // double dot
$x acute$           // acute
$x grave$           // grave
$x breve$           // breve
$x check$           // check
$arrow(x)$          // arrow
```

---

## Styles

| Style | Syntax | Example |
|-------|--------|---------|
| Upright | `upright(x)` | $upright(x)$ |
| Italic | `italic(x)` | $italic(x)$ |
| Bold | `bold(x)` | $bold(x)$ |
| Calligraphic | `cal(A)` | $cal(A)$ |
| Fraktur | `frak(A)` | $frak(A)$ |
| Blackboard | `bb(A)` | $bb(A)$ |
| Mono | `mono(x)` | $mono(x)$ |
| Sans | `sans(x)` | $sans(x)$ |

### Size Modifiers

```typst
$display(x)$    // display size
$inline(x)$     // inline size  
$script(x)$     // script size
$ss(x)$         // script-script size
```

---

## Text Operators

Predefined: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`, `cosh`, `tanh`, `log`, `ln`, `exp`, `det`, `dim`, `gcd`, `hom`, `inf`, `lim`, `liminf`, `limsup`, `max`, `min`, `Pr`, `sup`, `arg`, `deg`, `sgn`

Custom:
```typst
$op("Tr") A$           // custom operator
$op("lim", limits: #true)_x$  // with limits
```

---

## Under/Over Braces and Brackets

```typst
$underbrace(a + b, "sum")$
$overbrace(a + b, "sum")$
$underline(a + b)$
$overline(a + b)$
$cancel(x + y)$        // diagonal strikethrough
```

---

## Math Functions

Functions in math mode don't need `#` prefix. Arguments use math-mode syntax.

```typst
$frac(a^2, 2)$
$vec(1, 2, delim: "[")$
$mat(1, 2; 3, 4)$
```

Use `#` to pass code values:
```typst
$mat(..#range(1, 5).chunks(2))$   // spread array into matrix
$op("lim", limits: #true)_x$      // pass boolean
```

Semicolon merges preceding comma-separated arguments into an array:
```typst
$mat(1, 2; 3, 4)$   // same as mat((1, 2), (3, 4))
```

---

## Equation Parameters

```typc
math.equation(
  body: content,
  block: bool,
  numbering: none|str|function,
  supplement: auto|content|function,
  align: alignment,
  alt: none|str,         // accessibility description
  gap: length,
) -> content
```

---

## Common Symbols Reference

### Greek Letters

Lowercase: `alpha`, `beta`, `gamma`, `delta`, `epsilon`, `zeta`, `eta`, `theta`, `iota`, `kappa`, `lambda`, `mu`, `nu`, `xi`, `omicron`, `pi`, `rho`, `sigma`, `tau`, `upsilon`, `phi`, `chi`, `psi`, `omega`

Uppercase: `Alpha`, `Beta`, `Gamma`, `Delta`, `Epsilon`, `Zeta`, `Eta`, `Theta`, `Iota`, `Kappa`, `Lambda`, `Mu`, `Nu`, `Xi`, `Omicron`, `Pi`, `Rho`, `Sigma`, `Tau`, `Upsilon`, `Phi`, `Chi`, `Psi`, `Omega`

Variants: `epsilon.alt`, `theta.alt`, `phi.alt`, `rho.alt`, `sigma.alt`

### Operators

| Symbol | Name |
|--------|------|
| `+` `−` `×` `÷` `±` `∓` | `plus`, `minus`, `times`, `div`, `plus.minus`, `minus.plus` |
| `cdot` `*` | center dot |
| `and` `or` `not` | logical |
| `union` `inter` | set |
| `in` `notin` | element |
| `subset` `subset.eq` | subset |
| `supset` `supset.eq` | superset |
| `emptyset` | empty set |
| `forall` `exists` | quantifiers |
| `infinity` | infinity |
| `partial` | partial derivative |
| `nabla` | nabla |
| `integral` `iint` `iiint` `oint` | integrals |
| `sum` `product` `union.big` | big operators |

### Arrows

| Symbol | Name |
|--------|------|
| `->` | `arrow.r` |
| `<-` | `arrow.l` |
| `<->` | `arrow.l.r` |
| `=>` | `arrow.r.double` |
| `<=` | `arrow.l.double` |
| `==>` | `arrow.r.double.long` |
| `|->` | `arrow.r.bar` |
| `~>` | `arrow.r.squiggly` |
| `->>` | `arrow.r.double.head` |
| `-->` | `arrow.r.long` |

### Relations

| Symbol | Name |
|--------|------|
| `=` | equal |
| `eq.not` | not equal |
| `!=` | `eq.not` shorthand |
| `<` `>` | less, greater |
| `lt.eq` `gt.eq` | less/greater or equal |
| `approx` | approximately |
| `sim` | similar |
| `equiv` | equivalent |
| `prop` | proportional |
| `prec` `succ` | precedes, succeeds |

### Calculus

| Symbol | Name |
|--------|------|
| `dif` | differential d |
| `partial` | partial derivative |
| `integral` | integral |
| `iint` | double integral |
| `iiint` | triple integral |
| `oint` | contour integral |
| `sum` | summation |
| `product` | product |
| `infinity` | infinity |

### Number Sets

| Symbol | Name |
|--------|------|
| `NN` | natural numbers |
| `ZZ` | integers |
| `QQ` | rationals |
| `RR` | reals |
| `CC` | complex |
| `HH` | quaternions |
| `OO` | octonions |
| `FF` | finite field |
| `EE` | expected value |

---

## Math Module Access

All math functions are available directly in math mode. Outside math:

```typst
#math.frac(1, 2)
#math.sqrt(x)
#math.mat(1, 2; 3, 4)
```

Set math font:
```typst
#show math.equation: set text(font: "Fira Math")
```
