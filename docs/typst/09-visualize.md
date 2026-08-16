# Typst Visualize

> Applies to **Typst 0.15.1** (reviewed 2026-08-08).
>
> Images, shapes, colors, gradients, strokes, and drawing.

---

## Image

```typc
image(
  source: str|path|bytes,
  format: auto|str|dictionary,
  width: auto|relative,
  height: auto|relative|fraction,
  alt: none|str,
  page: int,
  fit: str,              // "cover", "contain", "stretch"
  scaling: auto|str,
  icc: auto|str|bytes,
) -> content
```

Supported formats: PNG, JPG/JPEG, GIF, SVG, PDF, WebP

```typst
#image("photo.jpg", width: 80%)
#image("diagram.svg", height: 200pt)
#image("doc.pdf", page: 2)
#figure(
  image("photo.jpg", width: 80%),
  caption: [A nice figure.],
)
```

---

## Shapes

### Rectangle

```typc
rect(
  width, height,
  fill: none|color|gradient|tiling,
  stroke: none|auto|length|color|gradient|stroke|dictionary,
  radius: relative|dictionary,     // corner rounding
  inset: relative|dictionary,       // inner padding
  outset: relative|dictionary,
  none|content,
) -> content
```

```typst
#rect(width: 100pt, height: 50pt, fill: red)
#rect(fill: blue, radius: 4pt, inset: 8pt)[Content inside]
#rect(width: 100%, height: 1pt, fill: black)  // horizontal rule
```

### Square

```typc
square(size, width, height, fill, stroke, radius, inset, outset, content)
```

### Circle

```typc
circle(
  radius: length,
  width, height, fill, stroke, inset, outset,
  content,
) -> content
```

```typst
#circle(radius: 25pt, fill: red)
#circle(inset: 8pt)[Centered text]
```

### Ellipse

```typc
ellipse(width, height, fill, stroke, inset, outset, content) -> content
```

### Polygon

```typc
polygon(
  fill, fill-rule: "non-zero"|"even-odd",
  stroke,
  ..vertices: array,    // ((x1, y1), (x2, y2), ...)
) -> content

// Regular polygon
polygon.regular(size, vertices: int, fill, stroke) -> content
```

```typst
#polygon(
  fill: blue.lighten(80%),
  stroke: blue,
  (20%, 0pt), (60%, 0pt), (80%, 2cm), (0%, 2cm),
)
#polygon.regular(size: 50pt, vertices: 6, fill: yellow)
```

### Line

```typc
line(
  start: array,        // (x, y)
  end: array,          // (x, y)
  length: relative,
  angle: angle,
  stroke: stroke-like,
) -> content
```

```typst
#line(length: 100%)
#line(end: (50%, 50%))
#line(length: 4cm, stroke: 2pt + maroon)
```

### Curve

```typc
curve(
  fill, fill-rule, stroke,
  ..curve.segments,
) -> content

curve.move(start: array, relative: bool)
curve.line(end: array, relative: bool)
curve.quadratic(control: array, end: array, relative: bool)
curve.cubic(control-start, control-end, end, relative: bool)
curve.close(mode: str)
```

```typst
#curve(
  curve.move((0pt, 50pt)),
  curve.line((100pt, 50pt)),
  curve.cubic(none, (90pt, 0pt), (50pt, 0pt)),
  curve.close(),
)
```

The former drawing `path` element was removed in Typst 0.15. Use `curve` for vector paths; the new foundations `path` type represents file-system paths instead.

---

## Color

### Constructors

```typc
rgb(r, g, b, a: 255)                    // 0-255
rgb("#RRGGBB" | "#RRGGBBAA")            // hex string
rgb(color, alpha: int)                   // with alpha
cmyk(c, m, y, k: float)                  // 0-100%
luma(lightness: int)                     // 0-255 grayscale
oklab(l: float, a: float, b: float, alpha: float)
oklch(l: float, c: float, h: angle, alpha: float)
color.linear-rgb(r, g, b, alpha: float)
color.hsl(h: angle, s: ratio, l: ratio, alpha: float)
color.hsv(h: angle, s: ratio, v: ratio, alpha: float)
color.spot(name: str, fallback: color)
```

### Predefined Colors

```
black, gray, silver, white, navy, blue, aqua, teal,
eastern, purple, fuchsia, maroon, red, orange, yellow,
olive, green, lime
```

### Color Methods

| Method | Description |
|--------|-------------|
| `color.lighten(factor: ratio)` | Lighten |
| `color.darken(factor: ratio)` | Darken |
| `color.saturate(factor: ratio)` | Increase saturation |
| `color.desaturate(factor: ratio)` | Decrease saturation |
| `color.alpha(value: float)` | Set transparency |
| `color.negate()` | Color negative |
| `color.rotate(angle)` | Hue rotation |
| `color.to-hex()` | Convert to hex string |

```typst
#rect(fill: red.lighten(50%))
#rect(fill: rgb("#1E90FF").darken(20%))
#text(fill: gradient.linear(..color.map.rainbow))[Rainbow]

// Spot ink with a process-color fallback and a 70% tint.
#let ink = color.spot("PANTONE 2221 C", rgb("#239dad"))
#rect(fill: ink.tint(70%))

// Diverging scientific color map added in 0.15.
#rect(fill: gradient.linear(..color.map.coolwarm))
```

---

## Gradient

### Linear

```typc
gradient.linear(..color-stops, space: "oklab", dir: dir, angle: angle) -> gradient
```

### Radial

```typc
gradient.radial(..stops, space: "oklab", center: array, radius: relative|array) -> gradient
```

### Conic

```typc
gradient.conic(..stops, space: "oklab", center: array, angle: angle) -> gradient
```

### Sharp / Stepped

```typc
gradient.sharp(..stops, steps: int, smoothness: ratio) -> gradient
```

### Repeat

```typc
gradient.repeat(gradient, repetitions: int, mirror: bool) -> gradient
```

```typst
#rect(fill: gradient.linear(red, blue))
#rect(fill: gradient.radial(yellow, orange, red))
#rect(fill: gradient.conic(..color.map.rainbow))
#text(fill: gradient.linear(red, blue, space: "oklch"))[Gradient text]
```

---

## Stroke

Define how to draw a line/border.

```typc
stroke(
  paint: auto|color|gradient|tiling,
  thickness: auto|length,
  cap: auto|str,          // "butt", "round", "square"
  join: auto|str,         // "miter", "round", "bevel"
  dash: none|auto|str|array|dictionary,
  miter-limit: auto|float,
) -> stroke
```

### Simple Stroke Shorthands

| Syntax | Meaning |
|--------|---------|
| `2pt` | 2pt thickness, inherited color |
| `red` | Inherited thickness, red color |
| `2pt + red` | 2pt red stroke |
| `(paint: red, thickness: 2pt, dash: "dashed")` | Full specification |

### Dash Patterns

`"solid"`, `"dotted"`, `"densely-dotted"`, `"loosely-dotted"`, `"dashed"`, `"densely-dashed"`, `"loosely-dashed"`, `"dash-dotted"`, `"densely-dash-dotted"`, `"loosely-dash-dotted"`

---

## Tiling

Repeating fill. The old `pattern` type was removed in Typst 0.15; use `tiling`.

```typc
tiling(size: array, spacing: array, relative: auto|str, offset: array, content) -> tiling
```

```typst
#let pat = tiling(size: (30pt, 30pt))[
  #place(line(start: (0%, 0%), end: (100%, 100%)))
  #place(line(start: (0%, 100%), end: (100%, 0%)))
]
#rect(fill: pat, width: 100%, height: 60pt)

// Shift the repeated cells without moving the painted object.
#rect(fill: tiling(size: (10pt, 10pt), offset: (5pt, 5pt))[
  #circle(radius: 1pt, fill: blue)
])
```
