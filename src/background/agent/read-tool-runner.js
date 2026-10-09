/** Read-only built-in tools: document, file structure, file switching, diagnostics, docs. */
import { LIMITS } from '../../shared/constants.js';
import { PROTOCOL } from '../../shared/protocol.js';
import { normalizeProjectRelativePath } from '../../shared/active-file.js';
import { DOCS_REVIEWED_DATE, DOCS_TYPST_VERSION, listDocTopics, readDocTopic } from '../docs.js';
import { abortableDelay, forwardToTab } from './page-bridge.js';
import {
  preflightFailure, waitForMessageFileContext, waitForRequestedProjectFile, waitForVisibleFileStructure
} from './tool-preflight.js';

function parseOptionalInteger(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : NaN;
}

export async function executeReadDocument(run, call, args) {
  const rawStart = parseOptionalInteger(args.start_line);
  const rawEnd = parseOptionalInteger(args.end_line);
  if (Number.isNaN(rawStart) || Number.isNaN(rawEnd)) return { ok: false, error: 'start_line and end_line must be integers' };
  const capValue = Number(args.max_chars ?? LIMITS.DEFAULT_READ_DOC_CHARS);
  const requestedCap = Number.isFinite(capValue) ? capValue : LIMITS.DEFAULT_READ_DOC_CHARS;
  const charCap = Math.min(Math.max(requestedCap, 4000), LIMITS.MAX_READ_DOC_TOOL_CHARS);
  const requestedStart = Math.max(rawStart ?? 1, 1);
  const requestedEnd = rawEnd == null ? null : Math.max(rawEnd, requestedStart);
  const guarded = await waitForMessageFileContext(run, call, {
    projection: 'numbered',
    startLine: requestedStart,
    ...(requestedEnd == null ? {} : { endLine: requestedEnd }),
    maxChars: charCap
  });
  if (!guarded.ok) return preflightFailure(guarded);
  const context = guarded.context;
  if (context?.error) return { ok: false, error: context.error };
  // The page always numbers the requested range itself; the worker only relays
  // its bounds so paging hints stay consistent with what was actually read.
  const body = typeof context?.numberedDocument === 'string' ? context.numberedDocument : '';
  const totalLines = Number.isInteger(context?.lineCount) ? context.lineCount : (body ? body.split('\n').length : 0);
  const startLine = Number.isInteger(context?.startLine) ? context.startLine : Math.min(requestedStart, totalLines || 1);
  const endLine = Number.isInteger(context?.endLine) ? context.endLine : Math.min(requestedEnd ?? totalLines, totalLines || startLine);
  const truncated = !!context?.truncated;
  const nextStartLine = Number.isInteger(context?.nextStartLine) ? context.nextStartLine : endLine + 1;
  return {
    ok: true,
    truncated,
    doc_chars: context?.docLength,
    approx_line_count: totalLines,
    cursor_line: context?.cursorLine,
    cursor_column: context?.cursorColumn,
    start_line: totalLines ? startLine : 0,
    end_line: totalLines ? endLine : 0,
    numbered_document: body + (truncated ? `\n... (truncated — continue with start_line=${nextStartLine})` : '')
  };
}

export async function executeReadFileStructure(run, call) {
  const guarded = await waitForVisibleFileStructure(run, call);
  if (!guarded.ok) return preflightFailure(guarded);
  const projectTree = guarded.projectTree;
  const collapsedFolders = projectTree.entries
    .filter(entry => entry.kind === 'folder' && entry.state === 'collapsed')
    .map(entry => entry.path);
  const unknownEntries = projectTree.entries
    .filter(entry => entry.kind === 'unknown')
    .map(entry => entry.path)
    .slice(0, 32);
  const incomplete = projectTree.truncated || collapsedFolders.length > 0 || unknownEntries.length > 0;
  return {
    ok: true,
    entries: projectTree.entries,
    truncated: projectTree.truncated,
    complete: !incomplete,
    collapsed_folders: collapsedFolders,
    unknown_entries: unknownEntries,
    note: unknownEntries.length
      ? 'Some rendered rows could not be classified as files or folders. Ask the user to identify or expand them, then call read_file_structure again.'
      : collapsedFolders.length
        ? 'Collapsed folder contents were not rendered and are unknown. '
          + 'Ask the user to expand them and call read_file_structure again if their children are needed.'
        : projectTree.truncated
          ? 'The rendered file tree exceeded the bounded entry limit. Narrow or expand the relevant area and call read_file_structure again.'
          : 'Only names and rendered hierarchy were read; no file contents were accessed.'
  };
}

export async function executeOpenProjectFile(run, call, args) {
  const requestedPath = normalizeProjectRelativePath(args.path);
  if (!requestedPath) {
    return { ok: false, code: 'INVALID_PROJECT_FILE_PATH', error: 'path must be a safe project-relative file path.' };
  }
  const previousFile = run.activeEditorFile?.relativePath || null;
  const guarded = await waitForRequestedProjectFile(run, call, requestedPath);
  if (!guarded.ok) return preflightFailure(guarded);
  run.activeEditorFile = guarded.activeFile;
  return {
    ok: true,
    active_file: requestedPath,
    previous_file: previousFile,
    text_editor_accessible: true,
    usage: 'Subsequent read_document and editor tools in this response now target active_file.'
  };
}

function diagnosticsFingerprint(response) {
  try {
    return JSON.stringify({
      error: response?.error || null,
      diagnostics: Array.isArray(response?.diagnostics) ? response.diagnostics : [],
      totalCount: Number.isInteger(response?.totalCount) ? response.totalCount : null,
      truncated: response?.truncated === true
    });
  } catch {
    return '';
  }
}

/** Re-read until two consecutive diagnostic reads agree, within a bounded number of reads. */
async function readStableDiagnostics(run) {
  let response = await forwardToTab(run, PROTOCOL.PAGE_GET_DIAGNOSTICS);
  let fingerprint = diagnosticsFingerprint(response);
  for (let read = 1; read < LIMITS.DIAGNOSTICS_STABILITY_MAX_READS; read++) {
    await abortableDelay(LIMITS.DIAGNOSTICS_STABILITY_INTERVAL_MS, run.signal);
    const next = await forwardToTab(run, PROTOCOL.PAGE_GET_DIAGNOSTICS);
    const nextFingerprint = diagnosticsFingerprint(next);
    if (nextFingerprint === fingerprint) return next;
    response = next;
    fingerprint = nextFingerprint;
  }
  return response;
}

export async function executeReadDiagnostics(run) {
  await abortableDelay(LIMITS.DIAGNOSTICS_SETTLE_DELAY_MS, run.signal);
  const response = await readStableDiagnostics(run);
  const diagnostics = Array.isArray(response?.diagnostics) ? response.diagnostics : [];
  const spelling = diagnostic => diagnostic?.kind === 'spelling';
  const status = diagnostic => diagnostic?.kind === 'typst-status';
  const compiler = diagnostic => !spelling(diagnostic) && !status(diagnostic);
  return {
    ok: !response?.error,
    error: response?.error || null,
    diagnostics,
    total_count: Number.isInteger(response?.totalCount) ? response.totalCount : diagnostics.length,
    truncated: response?.truncated === true,
    error_count: diagnostics.filter(item => item.severity === 'error' && compiler(item)).length,
    warning_count: diagnostics.filter(item => item.severity === 'warning' && compiler(item)).length,
    spelling_count: diagnostics.filter(spelling).length,
    status_count: diagnostics.filter(status).length
  };
}

export async function executeReadTypstDocs(args) {
  if (!String(args.topic || '').trim()) {
    return {
      ok: true,
      version: DOCS_TYPST_VERSION,
      reviewed_at: DOCS_REVIEWED_DATE,
      topics: listDocTopics(),
      usage: 'Call again with a topic id.'
    };
  }
  return readDocTopic(args.topic);
}
