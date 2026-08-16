import { DEFAULT_EDIT_FILE_LABEL } from '../shared/edit-checkpoint.js';
import { LIMITS } from '../shared/constants.js';
import { activeEditorFileFromContext, normalizeProjectRelativePath } from '../shared/active-file.js';

const EDIT_TOOL_NAMES = Object.freeze([
  'replace_lines',
  'search_replace',
  'patch_document',
  'insert_at_cursor',
  'replace_selection'
]);

const MAX_DOCUMENT_CHARS = LIMITS.MAX_EDITOR_TRANSACTION_CHARS;
const MAX_CHANGES = 128;
const MAX_CHANGED_LINES = 2_000;
const MAX_DIFF_EDIT_DISTANCE = 4_000;
const MAX_DIFF_TEXT_CHARS = 256_000;
const DIFF_CONTEXT_LINES = 3;

export function isEditorEditTool(name) {
  return EDIT_TOOL_NAMES.includes(name);
}

/** Resolve a model edit against one immutable editor snapshot without mutating it. */
export function prepareEditorEdit(name, args, context) {
  if (!isEditorEditTool(name)) return failure('UNSUPPORTED_EDIT_TOOL', `Cannot preview editor tool: ${name}`);
  if (!context || typeof context.fullText !== 'string') return failure('EDIT_CONTEXT_UNAVAILABLE', 'The live Typst document could not be read for preview.');
  if (typeof context.editorToken !== 'string' || !context.editorToken) return failure('EDIT_CONTEXT_UNAVAILABLE', 'The live Typst editor identity is unavailable. Reload the extension and retry.');
  const baseText = context.fullText;
  if (baseText.length > MAX_DOCUMENT_CHARS) {
    return failure('EDIT_PREVIEW_TOO_LARGE', `The document is too large to preview safely (${baseText.length} characters; limit ${MAX_DOCUMENT_CHARS}).`);
  }

  const resolved = resolveChanges(name, args || {}, context, baseText);
  if (!resolved.ok) return resolved;
  const changes = normalizeChanges(resolved.changes, baseText.length);
  if (!changes.ok) return changes;
  const proposedText = applyChanges(baseText, changes.changes);
  if (proposedText === baseText) {
    return { ok: true, noChanges: true, result: { ok: true, no_changes: true } };
  }

  const changedLines = changes.changes.reduce((total, change) => (
    total + lineCount(baseText.slice(change.from, change.to)) + lineCount(change.insert)
  ), 0);
  if (changedLines > MAX_CHANGED_LINES) {
    return failure('EDIT_PREVIEW_TOO_LARGE', `The proposed edit changes too many lines to review safely (${changedLines}; limit ${MAX_CHANGED_LINES}).`);
  }

  const diff = buildUnifiedDiff(baseText, proposedText);
  if (!diff.ok) return diff;
  const activeFile = activeEditorFileFromContext(context);
  return {
    ok: true,
    baseText,
    editorToken: context.editorToken,
    activeFile,
    changes: changes.changes,
    preview: {
      kind: 'unified-diff',
      fileLabel: editorFileLabel(context),
      additions: diff.additions,
      deletions: diff.deletions,
      hunks: diff.hunks
    }
  };
}

export function buildUnifiedDiff(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return failure('INVALID_DIFF_INPUT', 'Diff input must be text.');
  if (before === after) return { ok: true, additions: 0, deletions: 0, hunks: [] };
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const operations = diffLineOperations(oldLines, newLines);
  if (!operations) return failure('EDIT_PREVIEW_TOO_LARGE', 'The proposed line diff is too complex to render safely.');

  const rows = [];
  const changedIndexes = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;
  let previewChars = 0;
  for (const operation of operations) {
    const row = {
      kind: operation.kind,
      oldLine: operation.kind === 'insert' ? null : oldLine,
      newLine: operation.kind === 'delete' ? null : newLine,
      oldCursor: oldLine,
      newCursor: newLine,
      text: operation.text
    };
    rows.push(row);
    if (operation.kind === 'context') {
      oldLine += 1;
      newLine += 1;
    } else if (operation.kind === 'delete') {
      changedIndexes.push(rows.length - 1);
      deletions += 1;
      oldLine += 1;
      previewChars += operation.text.length;
    } else {
      changedIndexes.push(rows.length - 1);
      additions += 1;
      newLine += 1;
      previewChars += operation.text.length;
    }
  }
  if (previewChars > MAX_DIFF_TEXT_CHARS) {
    return failure('EDIT_PREVIEW_TOO_LARGE', `The proposed diff contains too much changed text to review safely (${previewChars} characters; limit ${MAX_DIFF_TEXT_CHARS}).`);
  }

  const ranges = hunkRanges(changedIndexes, rows.length, DIFF_CONTEXT_LINES);
  const hunks = ranges.map(([start, end]) => {
    const slice = rows.slice(start, end + 1);
    return {
      oldStart: rows[start].oldCursor,
      oldLines: slice.filter(row => row.kind !== 'insert').length,
      newStart: rows[start].newCursor,
      newLines: slice.filter(row => row.kind !== 'delete').length,
      rows: slice.map(({ kind, oldLine: oldNumber, newLine: newNumber, text }) => ({
        kind,
        oldLine: oldNumber,
        newLine: newNumber,
        text
      }))
    };
  });
  return { ok: true, additions, deletions, hunks };
}

function resolveChanges(name, args, context, text) {
  if (name === 'replace_lines') {
    const startLine = integer(args.start_line);
    const endLine = integer(args.end_line);
    if (startLine == null || endLine == null) return failure('INVALID_EDIT_ARGUMENTS', 'replace_lines requires integer start_line and end_line values.');
    if (typeof args.new_content !== 'string') return failure('INVALID_EDIT_ARGUMENTS', 'replace_lines requires string new_content.');
    if (startLine < 1 || endLine < startLine) return failure('INVALID_EDIT_RANGE', `Invalid line range ${startLine}-${endLine}.`);
    const start = lineRange(text, startLine);
    const end = lineRange(text, endLine);
    if (!start || !end) return failure('INVALID_EDIT_RANGE', `Line ${!start ? startLine : endLine} is past the end of the document.`);
    return { ok: true, changes: [{ from: start.from, to: end.to, insert: args.new_content }] };
  }

  if (name === 'search_replace') {
    if (typeof args.search !== 'string' || !args.search) return failure('INVALID_EDIT_ARGUMENTS', 'search_replace requires a non-empty search string.');
    if (typeof args.replace !== 'string') return failure('INVALID_EDIT_ARGUMENTS', 'search_replace requires a replacement string.');
    const from = text.indexOf(args.search);
    if (from < 0) return failure('EDIT_TARGET_NOT_FOUND', 'Search string not found in document.');
    return { ok: true, changes: [{ from, to: from + args.search.length, insert: args.replace }] };
  }

  if (name === 'patch_document') {
    if (!Array.isArray(args.edits) || args.edits.length === 0) return failure('INVALID_EDIT_ARGUMENTS', 'patch_document requires a non-empty edits array.');
    if (args.edits.length > MAX_CHANGES) return failure('EDIT_PREVIEW_TOO_LARGE', `patch_document supports at most ${MAX_CHANGES} edits.`);
    const changes = [];
    for (let index = 0; index < args.edits.length; index++) {
      const edit = args.edits[index] || {};
      if (typeof edit.search !== 'string' || !edit.search) return failure('INVALID_EDIT_ARGUMENTS', `Edit #${index + 1} requires a non-empty search string.`);
      if (typeof edit.replace !== 'string') return failure('INVALID_EDIT_ARGUMENTS', `Edit #${index + 1} requires a replacement string.`);
      const from = text.indexOf(edit.search);
      if (from < 0) return failure('EDIT_TARGET_NOT_FOUND', `Edit #${index + 1}: search string not found.`);
      if (edit.unique !== false && text.indexOf(edit.search, from + edit.search.length) >= 0) {
        return failure('EDIT_TARGET_AMBIGUOUS', `Edit #${index + 1}: search string appears more than once.`);
      }
      changes.push({ from, to: from + edit.search.length, insert: edit.replace });
    }
    return { ok: true, changes };
  }

  if (name === 'insert_at_cursor') {
    if (typeof args.text !== 'string') return failure('INVALID_EDIT_ARGUMENTS', 'insert_at_cursor requires string text.');
    const cursor = integer(context.cursorPos);
    if (cursor == null || cursor < 0 || cursor > text.length) return failure('EDIT_CONTEXT_UNAVAILABLE', 'The current cursor position is unavailable.');
    return { ok: true, changes: [{ from: cursor, to: cursor, insert: args.text }] };
  }

  if (name === 'replace_selection') {
    if (typeof args.text !== 'string') return failure('INVALID_EDIT_ARGUMENTS', 'replace_selection requires string text.');
    const from = integer(context.selectionFrom);
    const to = integer(context.selectionTo);
    if (from == null || to == null || from < 0 || to <= from || to > text.length) return failure('EDIT_CONTEXT_UNAVAILABLE', 'There is no current editor selection to replace.');
    return { ok: true, changes: [{ from, to, insert: args.text }] };
  }

  return failure('UNSUPPORTED_EDIT_TOOL', `Cannot preview editor tool: ${name}`);
}

function normalizeChanges(input, textLength) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CHANGES) return failure('INVALID_EDIT_CHANGES', 'The prepared edit has an invalid number of changes.');
  const changes = input.map(change => ({ from: change.from, to: change.to, insert: change.insert })).sort((a, b) => a.from - b.from || a.to - b.to);
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to > textLength || typeof change.insert !== 'string') {
      return failure('INVALID_EDIT_CHANGES', `Prepared edit #${index + 1} has an invalid range.`);
    }
    if (index > 0 && change.from < changes[index - 1].to) return failure('EDIT_RANGES_OVERLAP', `Prepared edit #${index + 1} overlaps a previous edit.`);
  }
  return { ok: true, changes };
}

function applyChanges(text, changes) {
  let cursor = 0;
  let output = '';
  for (const change of changes) {
    output += text.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return output + text.slice(cursor);
}

function diffLineOperations(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1;

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = myersOperations(oldMiddle, newMiddle);
  if (!middle) return null;
  return [
    ...oldLines.slice(0, prefix).map(text => ({ kind: 'context', text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map(text => ({ kind: 'context', text }))
  ];
}

function myersOperations(oldLines, newLines) {
  if (oldLines.length === 0) return newLines.map(text => ({ kind: 'insert', text }));
  if (newLines.length === 0) return oldLines.map(text => ({ kind: 'delete', text }));
  const max = oldLines.length + newLines.length;
  const limit = Math.min(max, MAX_DIFF_EDIT_DISTANCE);
  let frontier = new Map([[1, 0]]);
  const trace = [];

  for (let distance = 0; distance <= limit; distance++) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1);
      const right = frontier.get(diagonal - 1);
      let x;
      if (diagonal === -distance || (diagonal !== distance && (right ?? -1) < (down ?? -1))) x = down ?? 0;
      else x = (right ?? 0) + 1;
      let y = x - diagonal;
      while (x < oldLines.length && y < newLines.length && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= oldLines.length && y >= newLines.length) {
        trace.push(next);
        return backtrackOperations(trace, oldLines, newLines);
      }
    }
    trace.push(next);
    frontier = next;
  }
  return null;
}

function backtrackOperations(trace, oldLines, newLines) {
  const reversed = [];
  let x = oldLines.length;
  let y = newLines.length;
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const previous = trace[distance - 1];
    const diagonal = x - y;
    const down = previous.get(diagonal + 1);
    const right = previous.get(diagonal - 1);
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && (right ?? -1) < (down ?? -1))
      ? diagonal + 1
      : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: 'context', text: oldLines[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push({ kind: 'insert', text: newLines[y - 1] });
      y -= 1;
    } else {
      reversed.push({ kind: 'delete', text: oldLines[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: 'context', text: oldLines[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) reversed.push({ kind: 'delete', text: oldLines[--x] });
  while (y > 0) reversed.push({ kind: 'insert', text: newLines[--y] });
  return reversed.reverse();
}

function hunkRanges(changedIndexes, rowCount, contextLines) {
  const ranges = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(rowCount - 1, index + contextLines);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

function lineRange(text, targetLine) {
  let line = 1;
  let from = 0;
  for (let index = 0; index < text.length && line < targetLine; index++) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      from = index + 1;
    }
  }
  if (line !== targetLine) return null;
  const newline = text.indexOf('\n', from);
  return { from, to: newline < 0 ? text.length : newline };
}

export function editorFileLabel(value) {
  const activeFile = activeEditorFileFromContext(value);
  if (activeFile) return activeFile.relativePath;
  const workspace = value?.workspace && typeof value.workspace === 'object' ? value.workspace : value;
  if (!workspace || typeof workspace !== 'object') return DEFAULT_EDIT_FILE_LABEL;
  const candidates = [workspace.focused_element_file_hint, workspace.detail_path];
  return candidates.map(normalizeProjectRelativePath).find(Boolean) || DEFAULT_EDIT_FILE_LABEL;
}

function lineCount(text) {
  if (!text) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function failure(code, error) {
  return { ok: false, code, error };
}
