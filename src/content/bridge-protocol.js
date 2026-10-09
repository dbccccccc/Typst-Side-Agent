/**
 * Minimal classic-script adapter for the isolated/main-world bridge.
 *
 * It runs first in both worlds. Besides the message envelope validators it
 * publishes `globalThis.__typstAgentShared`, a generated copy of the
 * dependency-free shared modules, so the other content scripts never carry
 * hand-synchronized duplicates of path normalization or page bounds.
 */
(function (root) {
  'use strict';
  // BEGIN GENERATED SHARED RUNTIME
  // Generated from src/shared/page-limits.js and src/shared/active-file.js by scripts/sync-bridge-shared.mjs.
  // Do not edit by hand: change the shared module, then run `npm run sync:bridge`.
  (function () {
    const SHARED_RUNTIME_HASH = 'f2ba6ebf8c68b4ad';
    if (root.__typstAgentShared?.hash === SHARED_RUNTIME_HASH) return;
    // ---- src/shared/page-limits.js ----
    const PAGE_LIMITS = Object.freeze({
      MAX_DOCUMENT_CHARS: 1_048_576,
      MAX_EDITOR_TRANSACTION_CHARS: 1_000_000,
      MAX_SELECTION_CHARS: 65_536,
      MAX_WORKSPACE_CHARS: 65_536,
      MAX_DIAGNOSTICS: 200,
      MAX_DIAGNOSTICS_CHARS: 262_144,
      MAX_DIAGNOSTIC_MESSAGE_CHARS: 2_000,
      MAX_DIAGNOSTIC_SEVERITY_CHARS: 16,
      MAX_DIAGNOSTIC_KIND_CHARS: 32,
      MAX_DIAGNOSTIC_SNIPPET_CHARS: 500,
      MAX_PREVIEW_DATA_URL_CHARS: 2_097_152,
      MAX_PREVIEW_DIMENSION: 4096,
      MAX_NUMBERED_DOCUMENT_CHARS: 65_000,
      MAX_CONTEXT_REQUEST_CHARS: 64_000,
      MAX_CONTEXT_RESPONSE_CHARS: 2_300_000,
      MAX_PAGE_RESULT_CHARS: 64_000,
      MAX_ERROR_CHARS: 2_000,
      MAX_REQUEST_ID_CHARS: 200,
      MAX_EDITOR_TOKEN_CHARS: 200,
      MAX_FILE_LABEL_CHARS: 240,
      MAX_PREPARED_CHANGES: 128,
      MAX_PREPARED_INSERT_CHARS: 1_000_000,
      MAX_DIFF_HUNKS: 256,
      MAX_DIFF_ROWS: 5_000,
      MAX_DIFF_TEXT_CHARS: 512_000,
      MAX_INLINE_DIFF_ROWS: 2_000,
      MAX_PENDING_PAGE_REQUESTS: 64,
      PAGE_REQUEST_TIMEOUT_MS: 12_000,
      MAIN_WORLD_RECOVERY_DELAY_MS: 200,
      MAX_BRIDGE_NONCES: 8
    });
    // ---- src/shared/active-file.js ----
    const MAX_PATH_CHARS = 240;
    const MAX_PROJECT_LABEL_CHARS = 160;
    const MAX_SOURCE_CHARS = 64;
    const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
    const PROJECT_FILE_BASENAME_RE = /\.[a-z0-9][a-z0-9+_-]{0,31}$/i;

    /** Label used when the focused Typst file cannot be identified. */
    const DEFAULT_EDIT_FILE_LABEL = 'Current Typst document';

    function isProjectFileBasename(value) {
      return typeof value === 'string' && PROJECT_FILE_BASENAME_RE.test(value);
    }

    function normalizeProjectRelativePath(value) {
      if (typeof value !== 'string') return null;
      let path = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
      path = path.replace(/\/{2,}/g, '/');
      if (!path || path.length > MAX_PATH_CHARS || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
      const segments = path.split('/').map(segment => segment.trim());
      if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\0\r\n]/.test(segment))) return null;
      if (!PROJECT_FILE_BASENAME_RE.test(segments.at(-1) || '')) return null;
      return segments.join('/');
    }

    function normalizeActiveEditorFile(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const relativePath = normalizeProjectRelativePath(value.relativePath ?? value.relative_path ?? value.path);
      if (!relativePath) return null;
      const basename = relativePath.split('/').at(-1);
      const projectLabel = boundedText(value.projectLabel ?? value.project_label, MAX_PROJECT_LABEL_CHARS) || null;
      const requestedSource = boundedText(value.source, MAX_SOURCE_CHARS).toLowerCase();
      const source = /^[a-z0-9_+-]+$/.test(requestedSource) ? requestedSource : 'unknown';
      const requestedConfidence = boundedText(value.confidence, 16).toLowerCase();
      const confidence = CONFIDENCE_LEVELS.has(requestedConfidence) ? requestedConfidence : 'medium';
      return { projectLabel, relativePath, basename, source, confidence };
    }

    function activeEditorFileFromContext(context) {
      if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
      return normalizeActiveEditorFile(
        context.activeFile ?? context.active_file ??
        context.activeEditorFile ?? context.active_editor_file ??
        context.workspace?.active_editor_file ?? context.workspace?.activeEditorFile
      );
    }

    function sameActiveEditorFile(left, right) {
      const a = normalizeActiveEditorFile(left);
      const b = normalizeActiveEditorFile(right);
      return !!a && !!b && a.relativePath === b.relativePath;
    }

    function activeEditorFileLabel(value, fallback = DEFAULT_EDIT_FILE_LABEL) {
      const active = normalizeActiveEditorFile(value) || activeEditorFileFromContext(value);
      return active?.relativePath || fallback;
    }

    /**
     * The focused-file label that guards every editor write. The worker computes it
     * from a page context and the page computes it from its live workspace; both
     * must run this exact function or stale-file checks would disagree.
     */
    function editorFileLabel(value) {
      const activeFile = activeEditorFileFromContext(value);
      if (activeFile) return activeFile.relativePath;
      const workspace = value?.workspace && typeof value.workspace === 'object' ? value.workspace : value;
      if (!workspace || typeof workspace !== 'object') return DEFAULT_EDIT_FILE_LABEL;
      const candidates = [workspace.focused_element_file_hint, workspace.detail_path];
      return candidates.map(normalizeProjectRelativePath).find(Boolean) || DEFAULT_EDIT_FILE_LABEL;
    }

    function boundedText(value, max) {
      return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
    }
    root.__typstAgentShared = Object.freeze({ hash: SHARED_RUNTIME_HASH, PAGE_LIMITS, DEFAULT_EDIT_FILE_LABEL, isProjectFileBasename, normalizeProjectRelativePath, normalizeActiveEditorFile, activeEditorFileFromContext, sameActiveEditorFile, activeEditorFileLabel, editorFileLabel });
  })();
  // END GENERATED SHARED RUNTIME
  const shared = root.__typstAgentShared;
  const L = shared.PAGE_LIMITS;
  const BRIDGE_VERSION = 8;
  if (root.__typstAgentBridgeProtocol?.version === BRIDGE_VERSION) return;
  const TYPES = Object.freeze({
    RESPONSE: 'PROTOCOL_RESPONSE',
    PAGE_GET_CONTEXT: 'PAGE_GET_CONTEXT',
    PAGE_GET_PREVIEW: 'PAGE_GET_PREVIEW',
    PAGE_GET_DIAGNOSTICS: 'PAGE_GET_DIAGNOSTICS',
    PAGE_GET_PROBE: 'PAGE_GET_PROBE',
    PAGE_CANCEL_REQUEST: 'PAGE_CANCEL_REQUEST',
    PAGE_SHOW_EDIT_PREVIEW: 'PAGE_SHOW_EDIT_PREVIEW',
    PAGE_CLEAR_EDIT_PREVIEW: 'PAGE_CLEAR_EDIT_PREVIEW',
    PAGE_APPLY_EDIT: 'PAGE_APPLY_EDIT',
    PAGE_QUICK_SELECTION: 'PAGE_QUICK_SELECTION',
    PAGE_QUICK_IMAGE_PREVIEW: 'PAGE_QUICK_IMAGE_PREVIEW',
    PAGE_BRIDGE_INIT: 'PAGE_BRIDGE_INIT',
    PAGE_BRIDGE_READY: 'PAGE_BRIDGE_READY',
    QUICK_ATTACH_SELECTION: 'QUICK_ATTACH_SELECTION',
    QUICK_ATTACH_IMAGE_PREVIEW: 'QUICK_ATTACH_IMAGE_PREVIEW'
  });
  const PAGE_REQUESTS = new Set([
    TYPES.PAGE_GET_CONTEXT,
    TYPES.PAGE_GET_PREVIEW,
    TYPES.PAGE_GET_DIAGNOSTICS,
    TYPES.PAGE_GET_PROBE,
    TYPES.PAGE_CANCEL_REQUEST,
    TYPES.PAGE_SHOW_EDIT_PREVIEW,
    TYPES.PAGE_CLEAR_EDIT_PREVIEW,
    TYPES.PAGE_APPLY_EDIT
  ]);
  const RUN_SCOPED_REQUESTS = new Set([
    TYPES.PAGE_SHOW_EDIT_PREVIEW,
    TYPES.PAGE_CLEAR_EDIT_PREVIEW,
    TYPES.PAGE_APPLY_EDIT,
    TYPES.PAGE_CANCEL_REQUEST
  ]);
  const TYPE_SET = new Set(Object.values(TYPES));
  const CONTEXT_PROJECTIONS = ['full', 'edit', 'numbered', 'identity'];
  const CONTEXT_COUNTERS = [
    'cursorPos', 'cursorLine', 'cursorColumn', 'selectionFrom', 'selectionTo',
    'docLength', 'lineCount', 'startLine', 'endLine', 'nextStartLine'
  ];
  const CONTEXT_FIELDS = [
    'error', 'fullText', 'numberedDocument', 'cursorPos', 'cursorLine', 'cursorColumn',
    'selectedText', 'selectionFrom', 'selectionTo', 'docLength', 'lineCount', 'editorToken',
    'workspace', 'truncated', 'selectionTruncated', 'startLine', 'endLine', 'nextStartLine'
  ];
  const PROBE_FIELDS = ['editor', 'selection', 'typstCanvas', 'previewImage', 'improvePanel'];
  const DIAGNOSTIC_FIELDS = ['severity', 'message', 'line', 'column', 'kind', 'original', 'suggestion'];
  const PREPARED_EDIT_FIELDS = ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId'];

  function hasOwn(value, field) {
    return Object.prototype.hasOwnProperty.call(value, field);
  }

  function boundedString(value, max, allowEmpty = false) {
    return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max;
  }

  function optionalCounter(value) {
    return value == null || (Number.isInteger(value) && value >= 0);
  }

  function optionalBoolean(value) {
    return value == null || typeof value === 'boolean';
  }

  function validPreparedEditFields(payload) {
    return boundedString(payload.expectedText, L.MAX_EDITOR_TRANSACTION_CHARS, true) &&
      boundedString(payload.expectedEditorToken, L.MAX_EDITOR_TOKEN_CHARS) &&
      boundedString(payload.expectedFileLabel, L.MAX_FILE_LABEL_CHARS) &&
      boundedString(payload.callId, L.MAX_REQUEST_ID_CHARS) &&
      validChanges(payload.changes, payload.expectedText.length);
  }

  function validContextRequest(payload) {
    if (payload.projection != null && !CONTEXT_PROJECTIONS.includes(payload.projection)) return false;
    if (payload.startLine != null && (!Number.isInteger(payload.startLine) || payload.startLine < 1)) return false;
    if (payload.endLine != null && (!Number.isInteger(payload.endLine) || payload.endLine < 1)) return false;
    if (payload.startLine != null && payload.endLine != null && payload.endLine < payload.startLine) return false;
    return payload.maxChars == null ||
      (Number.isInteger(payload.maxChars) && payload.maxChars >= 1 && payload.maxChars <= L.MAX_CONTEXT_REQUEST_CHARS);
  }

  function validPreviewRequest(payload) {
    return optionalCounter(payload.tabId) &&
      optionalBoolean(payload.preferTypstCanvas) &&
      optionalBoolean(payload.preferAssetImage);
  }

  function validResponsePayload(payload) {
    if (typeof payload.ok !== 'boolean') return false;
    if (payload.ok) return hasOwn(payload, 'data') && !hasOwn(payload, 'error');
    return !!payload.error && typeof payload.error.code === 'string' && typeof payload.error.message === 'string';
  }

  function exactPayload(message) {
    const payload = message.payload;
    let allowed = [];
    let required = [];
    switch (message.type) {
      case TYPES.RESPONSE:
        allowed = ['ok', 'data', 'error'];
        required = ['ok'];
        if (!validResponsePayload(payload)) return false;
        break;
      case TYPES.PAGE_GET_CONTEXT:
        allowed = ['projection', 'startLine', 'endLine', 'maxChars'];
        if (!validContextRequest(payload)) return false;
        break;
      case TYPES.PAGE_GET_PREVIEW:
        allowed = ['tabId', 'preferTypstCanvas', 'preferAssetImage'];
        if (!validPreviewRequest(payload)) return false;
        break;
      case TYPES.PAGE_SHOW_EDIT_PREVIEW:
        allowed = [...PREPARED_EDIT_FIELDS, 'preview'];
        required = allowed;
        if (!validPreparedEditFields(payload) || !validDiffPreview(payload.preview)) return false;
        break;
      case TYPES.PAGE_APPLY_EDIT:
        allowed = [...PREPARED_EDIT_FIELDS, 'reviewedDiff'];
        required = allowed;
        if (!validPreparedEditFields(payload) || typeof payload.reviewedDiff !== 'boolean') return false;
        break;
      case TYPES.PAGE_CLEAR_EDIT_PREVIEW:
        allowed = ['callId'];
        required = allowed;
        if (!boundedString(payload.callId, L.MAX_REQUEST_ID_CHARS)) return false;
        break;
      case TYPES.PAGE_CANCEL_REQUEST:
        allowed = ['targetRequestId'];
        required = allowed;
        if (!boundedString(payload.targetRequestId, L.MAX_REQUEST_ID_CHARS)) return false;
        break;
      default:
        break;
    }
    if (Object.keys(payload).some(field => !allowed.includes(field))) return false;
    return required.every(field => hasOwn(payload, field));
  }

  root.__typstAgentBridgeProtocol = Object.freeze({
    version: BRIDGE_VERSION,
    TYPES,
    PAGE_REQUESTS,
    requestId(prefix) {
      const unique = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return `${prefix || 'page'}-${unique}`;
    },
    envelope(type, payload, options) {
      const out = { type, payload: payload && typeof payload === 'object' ? payload : {} };
      if (options?.requestId) out.requestId = String(options.requestId);
      if (options?.runId) out.runId = String(options.runId);
      if (options?.nonce) out.nonce = String(options.nonce);
      return out;
    },
    valid(message, expectedType) {
      if (!message || typeof message !== 'object') return false;
      if (typeof message.type !== 'string' || !TYPE_SET.has(message.type)) return false;
      if (expectedType && message.type !== expectedType) return false;
      if (typeof message.requestId !== 'string' || !message.requestId.trim()) return false;
      if (RUN_SCOPED_REQUESTS.has(message.type) && (typeof message.runId !== 'string' || !message.runId.trim())) return false;
      if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return false;
      return exactPayload(message);
    },
    validResponse(message, requestType) {
      if (!this.valid(message, TYPES.RESPONSE)) return false;
      return message.payload.ok === false || validResponseData(requestType, message.payload.data);
    },
    validResponseData
  });

  function validResponseData(requestType, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    switch (requestType) {
      case TYPES.PAGE_GET_CONTEXT: return validContextResponse(data);
      case TYPES.PAGE_GET_PREVIEW: return validPreviewResponse(data);
      case TYPES.PAGE_GET_DIAGNOSTICS: return validDiagnosticsResponse(data);
      case TYPES.PAGE_GET_PROBE:
        return exactObject(data, PROBE_FIELDS) && PROBE_FIELDS.every(key => typeof data[key] === 'boolean');
      case TYPES.PAGE_SHOW_EDIT_PREVIEW:
      case TYPES.PAGE_CLEAR_EDIT_PREVIEW:
      case TYPES.PAGE_APPLY_EDIT:
        return exactObject(data, ['result']) && !!data.result && typeof data.result === 'object' &&
          !Array.isArray(data.result) && jsonLength(data) <= L.MAX_PAGE_RESULT_CHARS;
      case TYPES.PAGE_CANCEL_REQUEST:
        return exactObject(data, ['cancelled']) && typeof data.cancelled === 'boolean';
      default:
        return false;
    }
  }

  function validContextResponse(data) {
    if (!exactObject(data, CONTEXT_FIELDS) || jsonLength(data) > L.MAX_CONTEXT_RESPONSE_CHARS) return false;
    if (data.error != null) return boundedString(data.error, L.MAX_ERROR_CHARS, true);
    if (data.fullText != null && !boundedString(data.fullText, L.MAX_DOCUMENT_CHARS, true)) return false;
    if (data.numberedDocument != null && !boundedString(data.numberedDocument, L.MAX_NUMBERED_DOCUMENT_CHARS, true)) return false;
    if (data.selectedText != null && !boundedString(data.selectedText, L.MAX_SELECTION_CHARS, true)) return false;
    if (data.editorToken != null && !boundedString(data.editorToken, L.MAX_EDITOR_TOKEN_CHARS)) return false;
    if (data.workspace != null && jsonLength(data.workspace) > L.MAX_WORKSPACE_CHARS) return false;
    if (!CONTEXT_COUNTERS.every(key => optionalCounter(data[key]))) return false;
    return optionalBoolean(data.truncated) && optionalBoolean(data.selectionTruncated);
  }

  function validPreviewResponse(data) {
    if (!exactObject(data, ['error', 'dataUrl', 'width', 'height', 'mimeType'])) return false;
    if (data.error != null) return boundedString(data.error, L.MAX_ERROR_CHARS, true);
    const validDimension = value => Number.isInteger(value) && value > 0 && value <= L.MAX_PREVIEW_DIMENSION;
    return boundedString(data.dataUrl, L.MAX_PREVIEW_DATA_URL_CHARS) &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(data.dataUrl) &&
      validDimension(data.width) && validDimension(data.height) &&
      (data.mimeType == null || ['image/png', 'image/jpeg', 'image/webp'].includes(data.mimeType));
  }

  function validDiagnostic(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !exactObject(item, DIAGNOSTIC_FIELDS)) return false;
    if (!boundedString(item.message, L.MAX_DIAGNOSTIC_MESSAGE_CHARS, true)) return false;
    if (item.severity != null && !boundedString(item.severity, L.MAX_DIAGNOSTIC_SEVERITY_CHARS, true)) return false;
    if (item.kind != null && !boundedString(item.kind, L.MAX_DIAGNOSTIC_KIND_CHARS, true)) return false;
    if (item.original != null && !boundedString(item.original, L.MAX_DIAGNOSTIC_SNIPPET_CHARS, true)) return false;
    if (item.suggestion != null && !boundedString(item.suggestion, L.MAX_DIAGNOSTIC_SNIPPET_CHARS, true)) return false;
    return optionalCounter(item.line) && optionalCounter(item.column);
  }

  function validDiagnosticsResponse(data) {
    if (!exactObject(data, ['diagnostics', 'error', 'truncated', 'totalCount'])) return false;
    if (jsonLength(data) > L.MAX_DIAGNOSTICS_CHARS) return false;
    if (!Array.isArray(data.diagnostics) || data.diagnostics.length > L.MAX_DIAGNOSTICS) return false;
    if (data.error != null && !boundedString(data.error, L.MAX_ERROR_CHARS, true)) return false;
    if (!optionalBoolean(data.truncated)) return false;
    if (data.totalCount != null && (!Number.isInteger(data.totalCount) || data.totalCount < data.diagnostics.length)) return false;
    return data.diagnostics.every(validDiagnostic);
  }

  function exactObject(value, allowed) {
    const permitted = new Set(allowed);
    return Object.keys(value).every(key => permitted.has(key));
  }

  function jsonLength(value) {
    try { return JSON.stringify(value).length; } catch { return Infinity; }
  }

  function validChanges(changes, textLength) {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > L.MAX_PREPARED_CHANGES) return false;
    let insertedChars = 0;
    let previousTo = 0;
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
      if (Object.keys(change).some(field => !['from', 'to', 'insert'].includes(field))) return false;
      if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0) return false;
      if (change.to < change.from || change.to > textLength || typeof change.insert !== 'string') return false;
      if (index > 0 && change.from < previousTo) return false;
      previousTo = change.to;
      insertedChars += change.insert.length;
      if (insertedChars > L.MAX_PREPARED_INSERT_CHARS) return false;
    }
    return true;
  }

  function validDiffRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (Object.keys(row).some(field => !['kind', 'oldLine', 'newLine', 'text'].includes(field))) return false;
    if (!['context', 'delete', 'insert'].includes(row.kind) || typeof row.text !== 'string') return false;
    if (row.oldLine != null && (!Number.isInteger(row.oldLine) || row.oldLine < 1)) return false;
    if (row.newLine != null && (!Number.isInteger(row.newLine) || row.newLine < 1)) return false;
    return !((row.kind === 'insert' && row.oldLine != null) || (row.kind === 'delete' && row.newLine != null));
  }

  function validDiffPreview(preview) {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return false;
    if (Object.keys(preview).some(field => !['kind', 'fileLabel', 'additions', 'deletions', 'hunks'].includes(field))) return false;
    if (preview.kind !== 'unified-diff' || !boundedString(preview.fileLabel, L.MAX_FILE_LABEL_CHARS)) return false;
    if (!Number.isInteger(preview.additions) || preview.additions < 0) return false;
    if (!Number.isInteger(preview.deletions) || preview.deletions < 0) return false;
    if (!Array.isArray(preview.hunks) || preview.hunks.length === 0 || preview.hunks.length > L.MAX_DIFF_HUNKS) return false;
    let rowCount = 0;
    let textChars = 0;
    for (const hunk of preview.hunks) {
      if (!hunk || typeof hunk !== 'object' || Array.isArray(hunk)) return false;
      if (Object.keys(hunk).some(field => !['oldStart', 'oldLines', 'newStart', 'newLines', 'rows'].includes(field))) return false;
      if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(value => Number.isInteger(value) && value >= 0)) return false;
      if (!Array.isArray(hunk.rows) || hunk.rows.length === 0) return false;
      for (const row of hunk.rows) {
        if (!validDiffRow(row)) return false;
        rowCount += 1;
        textChars += row.text.length;
        if (rowCount > L.MAX_DIFF_ROWS || textChars > L.MAX_DIFF_TEXT_CHARS) return false;
      }
    }
    return preview.additions + preview.deletions > 0;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
