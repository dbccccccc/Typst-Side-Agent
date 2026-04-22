# Typst Data Loading

> Loading external data: CSV, JSON, XML, YAML, TOML, CBOR, and plain text.

---

## csv

Read structured data from a CSV file.

```typc
csv(
  source: str|bytes,
  delimiter: str = ",",
  row-type: type = array,       // array or dictionary
) -> array
```

Returns a 2D array of strings (each row is an array of strings).

```typst
#let data = csv("data.csv")
#table(
  columns: data.first().len(),
  ..data.flatten(),
)

// With header row → dictionaries
#let data = csv("data.csv", row-type: dictionary)
#data.first().name    // access by column name

// Custom delimiter
#let tsv = csv("data.tsv", delimiter: "\t")
```

---

## json

Read/write JSON data.

```typc
json(source: str|bytes) -> any
json.encode(value, pretty: false) -> str
```

### JSON → Typst Conversion

| JSON | Typst |
|------|-------|
| `null` | `none` |
| `boolean` | `bool` |
| `number` | `float` or `int` |
| `string` | `str` |
| `array` | `array` |
| `object` | `dictionary` |

```typst
#let day = json("monday.json")
Temperature: #day.temperature
Weather: #day.weather

// Write JSON
#json.encode((name: "Typst", year: 2024))
#json.encode((name: "Typst"), pretty: true)
```

---

## xml

Read XML data.

```typc
xml(source: str|bytes) -> array
```

Returns array of dictionaries, each with:
- `tag`: element name (str)
- `attrs`: attribute dictionary (str → str)
- `children`: array of child nodes (dicts or strings)

```typst
#let data = xml("data.xml")
#let root = data.first()
#root.tag
#root.attrs
#root.children
```

---

## yaml

Read/write YAML data.

```typc
yaml(source: str|bytes) -> any
yaml.encode(value) -> str
```

| YAML | Typst |
|------|-------|
| `null`, `~`, empty | `none` |
| `boolean` | `bool` |
| `number` | `float` or `int` |
| `string` | `str` |
| `sequence` | `array` |
| `mapping` | `dictionary` |

```typst
#let config = yaml("config.yaml")
#config.title
#config.authors
```

---

## toml

Read/write TOML data.

```typc
toml(source: str|bytes) -> dictionary
toml.encode(value, pretty: false) -> str
```

| TOML | Typst |
|------|-------|
| `string` | `str` |
| `integer` | `int` |
| `float` | `float` |
| `boolean` | `bool` |
| `datetime` | `datetime` |
| `array` | `array` |
| `table` | `dictionary` |

```typst
#let details = toml("details.toml")
Title: #details.title
Authors: #(details.authors.join(", "))
```

---

## cbor

Read/write CBOR binary data.

```typc
cbor(source: str|bytes) -> any
cbor.encode(value) -> bytes
```

| CBOR | Typst |
|------|-------|
| `integer` | `int` or `float` |
| `bytes` | `bytes` |
| `float` | `float` |
| `text` | `str` |
| `bool` | `bool` |
| `null` | `none` |
| `array` | `array` |
| `map` | `dictionary` |

---

## read

Read plain text or raw bytes from any file.

```typc
read(path: str, encoding: "utf8"|none) -> str|bytes
```

```typst
// Read as text
#let html = read("page.html")
#raw(html, block: true, lang: "html")

// Read raw bytes
#let bytes = read("image.jpg", encoding: none)
```

---

## Pattern: Data-Driven Documents

```typst
// Load and iterate
#let people = json("people.json")
#for person in people {
  === #person.name
  Age: #person.age
  Role: #person.role
  \n
}

// Table from CSV
#let sales = csv("sales.csv")
#table(
  columns: sales.first().len(),
  fill: (x, y) => if y == 0 { silver },
  ..sales.flatten(),
)

// Config-driven styling
#let config = yaml("config.yaml")
#set text(font: config.font, size: config.size)
#set page(paper: config.paper, margin: config.margin)
```

---

## File Path Rules

| Path Type | Prefix | Resolves From |
|-----------|--------|---------------|
| Relative | (none) | Current .typ file |
| Absolute | `/` | Project root |
| Package | `@pkg/` | Package directory |

```typst
#image("img/logo.png")       // relative
#image("/assets/logo.png")    // project root
#json("@preview/mypkg/data.json")  // package file
```
