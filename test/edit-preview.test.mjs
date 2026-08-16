import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedDiff, isEditorEditTool, prepareEditorEdit } from '../src/background/edit-preview.js';

function context(fullText, overrides = {}) {
  return {
    fullText,
    editorToken: 'editor-main',
    cursorPos: overrides.cursorPos ?? 0,
    selectionFrom: overrides.selectionFrom ?? 0,
    selectionTo: overrides.selectionTo ?? 0,
    workspace: overrides.workspace || { focused_element_file_hint: 'main.typ' }
  };
}

function apply(text, changes) {
  let cursor = 0;
  let output = '';
  for (const change of changes) {
    output += text.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return output + text.slice(cursor);
}

test('editor edit registry recognizes every built-in mutation', () => {
  for (const name of ['replace_lines', 'search_replace', 'patch_document', 'insert_at_cursor', 'replace_selection']) {
    assert.equal(isEditorEditTool(name), true, name);
  }
  assert.equal(isEditorEditTool('read_document'), false);
});

test('edit previews carry the complete active breadcrumb path', () => {
  const prepared = prepareEditorEdit('search_replace', { search: 'old', replace: 'new' }, context('old', {
    workspace: { active_editor_file: {
      projectLabel: 'Project', relativePath: 'references/ref.bib', basename: 'ref.bib',
      source: 'header_breadcrumb', confidence: 'high'
    } }
  }));
  assert.equal(prepared.preview.fileLabel, 'references/ref.bib');
  assert.equal(prepared.activeFile.relativePath, 'references/ref.bib');
});

test('replace_lines resolves an absolute change and a unified diff', () => {
  const before = '= Title\nOld paragraph\nLast';
  const prepared = prepareEditorEdit('replace_lines', {
    start_line: 2,
    end_line: 2,
    new_content: 'New paragraph'
  }, context(before));
  assert.equal(prepared.ok, true);
  assert.equal(apply(before, prepared.changes), '= Title\nNew paragraph\nLast');
  assert.equal(prepared.preview.fileLabel, 'main.typ');
  assert.equal(prepared.preview.additions, 1);
  assert.equal(prepared.preview.deletions, 1);
  assert.deepEqual(prepared.preview.hunks[0].rows.map(row => [row.kind, row.text]), [
    ['context', '= Title'],
    ['delete', 'Old paragraph'],
    ['insert', 'New paragraph'],
    ['context', 'Last']
  ]);
});

test('empty replace_lines deletes exact physical line ranges at every boundary', () => {
  for (const [before, startLine, endLine, expected] of [
    ['a\nb\nc', 1, 1, 'b\nc'],
    ['a\nb\nc', 2, 2, 'a\nc'],
    ['a\nb\nc', 3, 3, 'a\nb'],
    ['a\nb\nc\nd', 2, 3, 'a\nd'],
    ['only', 1, 1, ''],
    ['a\n', 2, 2, 'a'],
    ['a\r\nb\r\nc', 2, 2, 'a\r\nc']
  ]) {
    const prepared = prepareEditorEdit('replace_lines', {
      start_line: startLine,
      end_line: endLine,
      new_content: ''
    }, context(before));
    assert.equal(prepared.ok, true, `${JSON.stringify(before)} ${startLine}-${endLine}`);
    assert.equal(apply(before, prepared.changes), expected, `${JSON.stringify(before)} ${startLine}-${endLine}`);
  }
});

test('non-empty CRLF line replacement preserves the original line ending', () => {
  const before = 'a\r\nb\r\nc';
  const prepared = prepareEditorEdit('replace_lines', {
    start_line: 2, end_line: 2, new_content: 'B'
  }, context(before));
  assert.equal(apply(before, prepared.changes), 'a\r\nB\r\nc');
});

test('search, patch, cursor, and selection edits use the captured snapshot', () => {
  const before = 'alpha\nbeta\ngamma';
  const search = prepareEditorEdit('search_replace', { search: 'beta', replace: 'BETA' }, context(before));
  assert.equal(apply(before, search.changes), 'alpha\nBETA\ngamma');

  const patch = prepareEditorEdit('patch_document', {
    edits: [
      { search: 'gamma', replace: 'G' },
      { search: 'alpha', replace: 'A' }
    ]
  }, context(before));
  assert.equal(apply(before, patch.changes), 'A\nbeta\nG');
  assert.ok(patch.changes[0].from < patch.changes[1].from);

  const cursor = prepareEditorEdit('insert_at_cursor', { text: '!' }, context(before, { cursorPos: 5 }));
  assert.equal(apply(before, cursor.changes), 'alpha!\nbeta\ngamma');

  const selection = prepareEditorEdit('replace_selection', { text: 'B' }, context(before, { selectionFrom: 6, selectionTo: 10 }));
  assert.equal(apply(before, selection.changes), 'alpha\nB\ngamma');
});

test('ambiguous or overlapping patch targets fail before approval', () => {
  const ambiguous = prepareEditorEdit('patch_document', {
    edits: [{ search: 'same', replace: 'x' }]
  }, context('same same'));
  assert.equal(ambiguous.code, 'EDIT_TARGET_AMBIGUOUS');

  const overlap = prepareEditorEdit('patch_document', {
    edits: [
      { search: 'abc', replace: 'x' },
      { search: 'bc', replace: 'y' }
    ]
  }, context('abcd'));
  assert.equal(overlap.code, 'EDIT_RANGES_OVERLAP');
});

test('no-op edits skip approval and distant changes form separate hunks', () => {
  const noChange = prepareEditorEdit('search_replace', { search: 'same', replace: 'same' }, context('same'));
  assert.deepEqual(noChange, { ok: true, noChanges: true, result: { ok: true, no_changes: true } });

  const beforeLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines[1] = 'changed 2';
  afterLines[21] = 'changed 22';
  const diff = buildUnifiedDiff(beforeLines.join('\n'), afterLines.join('\n'));
  assert.equal(diff.ok, true);
  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 2);
});
