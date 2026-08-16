import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeEditorFileFromContext, activeEditorFileLabel, normalizeActiveEditorFile,
  normalizeProjectRelativePath, sameActiveEditorFile
} from '../src/shared/active-file.js';

test('active file normalization keeps bounded project-relative file paths', () => {
  assert.equal(normalizeProjectRelativePath(' ./chapters\\main.typ '), 'chapters/main.typ');
  assert.equal(normalizeProjectRelativePath('references/ref.bib'), 'references/ref.bib');
  assert.equal(normalizeProjectRelativePath('images/figure.png'), 'images/figure.png');
  assert.equal(normalizeProjectRelativePath('../main.typ'), null);
  assert.equal(normalizeProjectRelativePath('https://example.com/main.typ'), null);
  assert.equal(normalizeProjectRelativePath('LICENSE'), null);

  assert.deepEqual(normalizeActiveEditorFile({
    projectLabel: ' test ', relativePath: './references/ref.bib', basename: 'ignored.typ',
    source: 'HEADER_BREADCRUMB', confidence: 'HIGH'
  }), {
    projectLabel: 'test', relativePath: 'references/ref.bib', basename: 'ref.bib',
    source: 'header_breadcrumb', confidence: 'high'
  });
});

test('active file identity is read from a page workspace and compares full paths', () => {
  const context = { workspace: { active_editor_file: {
    projectLabel: 'Project', relativePath: 'references/ref.bib', source: 'header_breadcrumb', confidence: 'high'
  } } };
  const active = activeEditorFileFromContext(context);
  assert.equal(active.relativePath, 'references/ref.bib');
  assert.equal(activeEditorFileLabel(context), 'references/ref.bib');
  assert.equal(sameActiveEditorFile(active, { relativePath: 'references/ref.bib' }), true);
  assert.equal(sameActiveEditorFile(active, { relativePath: 'appendix/ref.bib' }), false);
  assert.equal(activeEditorFileLabel({}, 'fallback.typ'), 'fallback.typ');
});
