import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/content/diagnostics.js', import.meta.url), 'utf8');

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.parentElement = null;
  }

  get textContent() {
    return this.nodeValue;
  }
}

function selectorMatches(element, selector) {
  const part = selector.trim();
  const match = part.match(/^([a-z][\w-]*)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i);
  if (!match) return false;
  const [, tag, attribute, expected] = match;
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  if (!attribute) return true;
  const actual = element.getAttribute(attribute);
  return expected == null ? actual != null : actual === expected;
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.childNodes = [];
    this.parentElement = null;
  }

  append(...children) {
    for (const value of children) {
      const child = typeof value === 'string' ? new FakeText(value) : value;
      child.parentElement = this;
      this.childNodes.push(child);
    }
    return this;
  }

  get children() {
    return this.childNodes.filter(child => child.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map(child => child.textContent).join('');
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  contains(other) {
    for (let current = other; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  getBoundingClientRect() {
    return { left: 0, right: 300, top: 0, bottom: 20, width: 300, height: 20 };
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',');
    const results = [];
    const visit = node => {
      for (const child of node.children) {
        if (selectors.some(part => selectorMatches(child, part))) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

class FakeDocument {
  constructor(body) {
    this.body = body;
    this.defaultView = { innerWidth: 1400 };
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

function element(tag, attributes, ...children) {
  return new FakeElement(tag, attributes).append(...children);
}

function improveFixture({ summary = null, rows = [] } = {}) {
  const panel = element('div', { role: 'region' },
    element('strong', { role: 'heading' }, 'Improve'));

  const content = element('div', {});
  const header = element('button', {},
    element('p', {}, 'Typst'),
    element('p', {}, summary || 'Compiler'));
  content.append(element('div', {}, header));

  const list = element('div', { role: 'list' });
  for (const row of rows) {
    const item = element('div', { role: 'listitem' },
      element('div', {}, element('p', {}, row.message)));
    if (row.line != null) {
      const severity = row.severity ? `${row.severity}, ` : '';
      item.append(element('span', {}, `(${severity}line ${row.line})`));
    }
    list.append(item);
  }
  content.append(list);
  panel.append(content);

  const body = element('body', {}, panel);
  return new FakeDocument(body);
}

function emptyImproveFixture() {
  const panel = element('div', { role: 'region' },
    element('strong', { role: 'heading' }, 'Improve'),
    element('p', {}, 'A list of improvements will be displayed here. These include compiler errors, comments, and misspellings.'),
    element('p', {}, 'There is nothing we can suggest at the moment. Keep up the good work!'));
  return new FakeDocument(element('body', {}, panel));
}

function extractor() {
  const context = vm.createContext({ console, Node: { TEXT_NODE: 3 } });
  vm.runInContext(source, context, { filename: 'diagnostics.js' });
  return document => JSON.parse(JSON.stringify(context.__typstAgentImproveExtract(document)));
}

test('extracts a project-level BibLaTeX compiler error without a line badge', () => {
  const extract = extractor();
  const diagnostics = extract(improveFixture({
    summary: '1 compiler error',
    rows: [{ message: 'Failed to parse BibLaTeX (expected comma)' }]
  }));

  assert.deepEqual(diagnostics, [{
    line: null,
    column: null,
    severity: 'error',
    kind: 'typst',
    original: null,
    suggestion: null,
    message: 'Failed to parse BibLaTeX (expected comma)'
  }]);
});

test('keeps line diagnostics and project diagnostics in the same compiler group', () => {
  const extract = extractor();
  const diagnostics = extract(improveFixture({
    summary: '1 compiler error, 1 warning',
    rows: [
      { message: 'Failed to parse BibLaTeX (expected comma)' },
      { message: 'Unknown font family', line: 12, severity: 'warning' }
    ]
  }));

  assert.equal(diagnostics.length, 2, JSON.stringify(diagnostics));
  assert.deepEqual(
    diagnostics.map(item => ({ message: item.message, line: item.line, severity: item.severity })),
    [
      { message: 'Unknown font family', line: 12, severity: 'warning' },
      { message: 'Failed to parse BibLaTeX (expected comma)', line: null, severity: 'error' }
    ]
  );
});

test('uses the compiler summary as a safety net when a detail row is unavailable', () => {
  const extract = extractor();
  const diagnostics = extract(improveFixture({
    summary: '2 compiler errors',
    rows: [{ message: 'Failed to parse BibLaTeX (expected comma)' }]
  }));

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics.filter(item => item.severity === 'error').length, 2);
  assert.equal(diagnostics[1].kind, 'typst-summary');
  assert.match(diagnostics[1].message, /reports 2 compiler errors/i);
});

test('returns clean only when the visible compiler summary explicitly reports no errors', () => {
  const extract = extractor();
  assert.deepEqual(extract(improveFixture({ summary: 'No compiler errors' })), []);
});

test('recognizes the real Typst empty Improve view as explicitly clean', () => {
  const extract = extractor();
  assert.deepEqual(extract(emptyImproveFixture()), []);
});

test('surfaces parser uncertainty instead of treating an unrecognized panel as clean', () => {
  const extract = extractor();
  const diagnostics = extract(improveFixture());

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'typst-status');
  assert.match(diagnostics[0].message, /could not be verified/i);
});
