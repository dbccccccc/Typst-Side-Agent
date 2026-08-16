import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectTree, normalizeProjectTreePath, projectTreeFromContext, PROJECT_TREE_LIMITS
} from '../src/shared/project-tree.js';

test('project tree normalization preserves bounded hierarchy and collapsed state', () => {
  const tree = normalizeProjectTree({
    source: 'files_panel_dom',
    entries: [
      { path: ' 123 ', kind: 'folder', state: 'expanded' },
      { path: '123/not opened folder', kind: 'folder', state: 'collapsed' },
      { path: '123\\456.typ', kind: 'file' },
      { path: 'main.typ', kind: 'file' },
      { path: 'main.typ', kind: 'file' },
      { path: '../outside.typ', kind: 'file' }
    ],
    truncated: false
  });
  assert.deepEqual(tree, {
    source: 'files_panel_dom',
    entries: [
      { path: '123', kind: 'folder', state: 'expanded' },
      { path: '123/not opened folder', kind: 'folder', state: 'collapsed' },
      { path: '123/456.typ', kind: 'file' },
      { path: 'main.typ', kind: 'file' }
    ],
    truncated: false
  });
});

test('project tree normalization caps entries and context lookup accepts workspace data only', () => {
  const entries = Array.from({ length: PROJECT_TREE_LIMITS.maxEntries + 12 }, (_, index) => ({
    path: `chapters/${index}.typ`, kind: 'file'
  }));
  const tree = projectTreeFromContext({ workspace: {
    project_file_tree: { source: 'files_panel_dom', entries, truncated: false }
  } });
  assert.equal(tree.entries.length, PROJECT_TREE_LIMITS.maxEntries);
  assert.equal(tree.truncated, true);
  assert.equal(projectTreeFromContext({ projectTree: { source: 'files_panel_dom', entries, truncated: false } }), null);
  assert.equal(projectTreeFromContext({ workspace: { project_file_tree: { source: 'invented', entries, truncated: false } } }), null);
});

test('project tree paths reject traversal, protocols, controls, and oversized segments', () => {
  assert.equal(normalizeProjectTreePath('chapters/intro.typ'), 'chapters/intro.typ');
  for (const value of ['../secret.typ', 'https://example.com/x.typ', 'a\nfile.typ', `folder/${'x'.repeat(161)}`]) {
    assert.equal(normalizeProjectTreePath(value), null, value);
  }
});
