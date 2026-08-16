import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'src/content/workspace.js'), 'utf8');

function loadExtractor() {
  const context = vm.createContext({ console, window: { innerWidth: 1400, innerHeight: 900 } });
  vm.runInContext(source, context, { filename: 'workspace.js' });
  return context.__typstAgentWorkspaceExtract;
}

function emptyRoot(text = '') {
  return {
    innerText: text,
    textContent: text,
    children: [],
    querySelectorAll() { return []; }
  };
}

function textOnlyDocument(text, title = '') {
  const body = emptyRoot(text);
  return {
    title,
    body,
    activeElement: null,
    defaultView: { innerWidth: 1400, innerHeight: 900 },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function breadcrumbElement(text, rect, parent = null, attrs = {}) {
  return {
    textContent: text,
    innerText: text,
    parentElement: parent,
    children: [],
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }; },
    querySelectorAll() { return []; }
  };
}

function structuralBreadcrumbDocument(segments) {
  const body = emptyRoot(segments.join('\n'));
  const container = breadcrumbElement(segments.join(' '), { left: 500, top: 4, width: 400, height: 38 }, body, {
    role: 'heading', 'aria-level': '1'
  });
  const crumbs = segments.map((segment, index) => breadcrumbElement(
    segment, { left: 560 + index * 90, top: 8, width: 80, height: 26 }, container
  ));
  container.children = crumbs;
  container.querySelectorAll = () => crumbs;
  return {
    title: `${segments[1]} – ${segments.at(-1)} – Typst`,
    body,
    activeElement: null,
    defaultView: { innerWidth: 1400, innerHeight: 900 },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('[role="heading"]')) return [container];
      if (selector.startsWith('a, button, span, strong')) return crumbs;
      return [];
    }
  };
}

test('workspace parses the real Typst account-project-root-file breadcrumb', () => {
  const workspace = loadExtractor()(structuralBreadcrumbDocument(['dbcccc', 'test', 'ref.bib']));
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.active_editor_file)), {
    projectLabel: 'test',
    relativePath: 'ref.bib',
    basename: 'ref.bib',
    source: 'header_breadcrumb',
    confidence: 'high'
  });
  assert.equal(workspace.detail_path, null, 'the editor breadcrumb is not conflated with an inspected asset');
  assert.ok(workspace.file_tree_paths_guess.includes('ref.bib'));
});

test('workspace keeps only folders after the account and project in a nested path', () => {
  const workspace = loadExtractor()(structuralBreadcrumbDocument(['dbcccc', 'test', 'chapters', 'intro.typ']));
  assert.equal(workspace.active_editor_file.relativePath, 'chapters/intro.typ');
  assert.equal(workspace.active_editor_file.projectLabel, 'test');
  assert.equal(workspace.active_editor_file.source, 'header_breadcrumb');
});

test('workspace falls back to the real Typst document-title shape', () => {
  const workspace = loadExtractor()(textOnlyDocument('Typst File Edit View Help', 'test – ref.bib – Typst'));
  assert.equal(workspace.active_editor_file.relativePath, 'ref.bib');
  assert.equal(workspace.active_editor_file.projectLabel, 'test');
  assert.equal(workspace.active_editor_file.source, 'document_title');
  assert.equal(workspace.active_editor_file.confidence, 'medium');
});

test('workspace has a bounded textual breadcrumb fallback when semantic nodes are unavailable', () => {
  const workspace = loadExtractor()(textOnlyDocument('Typst File Edit View Help dbcccc > test > chapters > intro.typ Files'));
  assert.equal(workspace.active_editor_file.relativePath, 'chapters/intro.typ');
  assert.equal(workspace.active_editor_file.projectLabel, 'test');
  assert.equal(workspace.active_editor_file.source, 'body_breadcrumb');
  assert.equal(workspace.active_editor_file.confidence, 'medium');
});
