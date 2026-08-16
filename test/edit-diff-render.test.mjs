import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = '';
    this.children = [];
    this.attributes = {};
    this._text = '';
    this.title = '';
    this.tabIndex = -1;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

function findByClass(root, className) {
  if (String(root.className).split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

test('unified diff renderer shows numbered safe text rows and review stats', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
  try {
    const { renderEditDiffPreview } = await import('../src/sidepanel/edit-diff.js');
    const rendered = renderEditDiffPreview({
      kind: 'unified-diff',
      fileLabel: 'main.typ',
      additions: 1,
      deletions: 1,
      hunks: [{
        oldStart: 3,
        oldLines: 1,
        newStart: 3,
        newLines: 1,
        rows: [
          { kind: 'delete', oldLine: 3, newLine: null, text: '<img src=x onerror=alert(1)>' },
          { kind: 'insert', oldLine: null, newLine: 3, text: '= Safe' }
        ]
      }]
    });
    assert.equal(rendered.attributes['aria-label'], 'Proposed changes to main.typ');
    assert.match(rendered.textContent, /main\.typ\+1−1@@ -3,1 \+3,1 @@/);
    assert.match(rendered.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(findByClass(rendered, 'edit-diff-delete').children[0].textContent, '3');
    assert.equal(findByClass(rendered, 'edit-diff-insert').children[1].textContent, '3');
    assert.equal(findByClass(rendered, 'edit-diff-body').tabIndex, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
