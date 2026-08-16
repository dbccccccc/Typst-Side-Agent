/** Minimal classic-script adapter for the isolated/main-world bridge. */
(function (root) {
  'use strict';
  const BRIDGE_VERSION = 7;
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
  const TYPE_SET = new Set(Object.values(TYPES));

  function exactPayload(message) {
    const payload = message.payload;
    let allowed = [];
    let required = [];
    if (message.type === TYPES.RESPONSE) {
      allowed = ['ok', 'data', 'error'];
      required = ['ok'];
      if (typeof payload.ok !== 'boolean') return false;
      if (payload.ok && (!Object.prototype.hasOwnProperty.call(payload, 'data') || Object.prototype.hasOwnProperty.call(payload, 'error'))) return false;
      if (!payload.ok && (!payload.error || typeof payload.error.code !== 'string' || typeof payload.error.message !== 'string')) return false;
    } else if (message.type === TYPES.PAGE_GET_CONTEXT) {
      allowed = ['projection', 'startLine', 'endLine', 'maxChars'];
      if (payload.projection != null && !['full', 'edit', 'numbered', 'identity'].includes(payload.projection)) return false;
      if (payload.startLine != null && (!Number.isInteger(payload.startLine) || payload.startLine < 1)) return false;
      if (payload.endLine != null && (!Number.isInteger(payload.endLine) || payload.endLine < 1)) return false;
      if (payload.startLine != null && payload.endLine != null && payload.endLine < payload.startLine) return false;
      if (payload.maxChars != null && (!Number.isInteger(payload.maxChars) || payload.maxChars < 1 || payload.maxChars > 64_000)) return false;
    } else if (message.type === TYPES.PAGE_GET_PREVIEW) {
      allowed = ['tabId', 'preferTypstCanvas', 'preferAssetImage'];
      if (payload.tabId != null && (!Number.isInteger(payload.tabId) || payload.tabId < 0)) return false;
      if (payload.preferTypstCanvas != null && typeof payload.preferTypstCanvas !== 'boolean') return false;
      if (payload.preferAssetImage != null && typeof payload.preferAssetImage !== 'boolean') return false;
    } else if (message.type === TYPES.PAGE_SHOW_EDIT_PREVIEW) {
      allowed = ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId', 'preview'];
      required = allowed;
      if (typeof payload.expectedText !== 'string' || payload.expectedText.length > 1_000_000 || typeof payload.expectedEditorToken !== 'string' || !payload.expectedEditorToken || payload.expectedEditorToken.length > 200 || typeof payload.expectedFileLabel !== 'string' || !payload.expectedFileLabel || payload.expectedFileLabel.length > 240 || typeof payload.callId !== 'string' || !payload.callId || !validChanges(payload.changes, payload.expectedText.length) || !validDiffPreview(payload.preview)) return false;
    } else if (message.type === TYPES.PAGE_APPLY_EDIT) {
      allowed = ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId'];
      required = allowed;
      if (typeof payload.expectedText !== 'string' || payload.expectedText.length > 1_000_000 || typeof payload.expectedEditorToken !== 'string' || !payload.expectedEditorToken || payload.expectedEditorToken.length > 200 || typeof payload.expectedFileLabel !== 'string' || !payload.expectedFileLabel || payload.expectedFileLabel.length > 240 || typeof payload.callId !== 'string' || !payload.callId || !validChanges(payload.changes, payload.expectedText.length)) return false;
    } else if (message.type === TYPES.PAGE_CLEAR_EDIT_PREVIEW) {
      allowed = ['callId'];
      required = allowed;
      if (typeof payload.callId !== 'string' || !payload.callId) return false;
    } else if (message.type === TYPES.PAGE_CANCEL_REQUEST) {
      allowed = ['targetRequestId'];
      required = allowed;
      if (typeof payload.targetRequestId !== 'string' || !payload.targetRequestId || payload.targetRequestId.length > 200) return false;
    }
    if (Object.keys(payload).some(field => !allowed.includes(field))) return false;
    return required.every(field => Object.prototype.hasOwnProperty.call(payload, field));
  }
  root.__typstAgentBridgeProtocol = Object.freeze({
    version: BRIDGE_VERSION,
    TYPES,
    PAGE_REQUESTS,
    requestId(prefix) {
      return `${prefix || 'page'}-${root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    },
    envelope(type, payload, options) {
      const out = { type, payload: payload && typeof payload === 'object' ? payload : {} };
      if (options?.requestId) out.requestId = String(options.requestId);
      if (options?.runId) out.runId = String(options.runId);
      if (options?.nonce) out.nonce = String(options.nonce);
      return out;
    },
    valid(message, expectedType) {
      return !!message && typeof message === 'object' &&
        typeof message.type === 'string' && TYPE_SET.has(message.type) && (!expectedType || message.type === expectedType) &&
        typeof message.requestId === 'string' && !!message.requestId.trim() &&
        (![TYPES.PAGE_SHOW_EDIT_PREVIEW, TYPES.PAGE_CLEAR_EDIT_PREVIEW, TYPES.PAGE_APPLY_EDIT, TYPES.PAGE_CANCEL_REQUEST].includes(message.type) || (typeof message.runId === 'string' && !!message.runId.trim())) &&
        message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) &&
        exactPayload(message);
    },
    validResponse(message, requestType) {
      return this.valid(message, TYPES.RESPONSE) && message.payload.ok === false
        ? true
        : this.valid(message, TYPES.RESPONSE) && validResponseData(requestType, message.payload.data);
    },
    validResponseData
  });

  const MAX_DOCUMENT_CHARS = 1_048_576;
  const MAX_SELECTION_CHARS = 65_536;
  const MAX_WORKSPACE_CHARS = 65_536;
  const MAX_DIAGNOSTICS = 200;
  const MAX_DIAGNOSTICS_CHARS = 262_144;
  const MAX_PREVIEW_CHARS = 2_097_152;

  function validResponseData(requestType, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (requestType === TYPES.PAGE_GET_CONTEXT) return validContextResponse(data);
    if (requestType === TYPES.PAGE_GET_PREVIEW) return validPreviewResponse(data);
    if (requestType === TYPES.PAGE_GET_DIAGNOSTICS) return validDiagnosticsResponse(data);
    if (requestType === TYPES.PAGE_GET_PROBE) {
      return exactObject(data, ['editor', 'selection', 'typstCanvas', 'previewImage', 'improvePanel']) &&
        ['editor', 'selection', 'typstCanvas', 'previewImage', 'improvePanel'].every(key => typeof data[key] === 'boolean');
    }
    if ([TYPES.PAGE_SHOW_EDIT_PREVIEW, TYPES.PAGE_CLEAR_EDIT_PREVIEW, TYPES.PAGE_APPLY_EDIT].includes(requestType)) {
      return exactObject(data, ['result']) && data.result && typeof data.result === 'object' && !Array.isArray(data.result) && jsonLength(data) <= 64_000;
    }
    if (requestType === TYPES.PAGE_CANCEL_REQUEST) {
      return exactObject(data, ['cancelled']) && typeof data.cancelled === 'boolean';
    }
    return false;
  }

  function validContextResponse(data) {
    const allowed = [
      'error', 'fullText', 'numberedDocument', 'cursorPos', 'cursorLine', 'cursorColumn',
      'selectedText', 'selectionFrom', 'selectionTo', 'docLength', 'lineCount', 'editorToken',
      'workspace', 'truncated', 'selectionTruncated', 'startLine', 'endLine', 'nextStartLine'
    ];
    if (!exactObject(data, allowed) || jsonLength(data) > 2_300_000) return false;
    if (data.error != null) return typeof data.error === 'string' && data.error.length <= 2_000;
    if (data.fullText != null && (typeof data.fullText !== 'string' || data.fullText.length > MAX_DOCUMENT_CHARS)) return false;
    if (data.numberedDocument != null && (typeof data.numberedDocument !== 'string' || data.numberedDocument.length > 65_000)) return false;
    if (data.selectedText != null && (typeof data.selectedText !== 'string' || data.selectedText.length > MAX_SELECTION_CHARS)) return false;
    if (data.editorToken != null && (typeof data.editorToken !== 'string' || !data.editorToken || data.editorToken.length > 200)) return false;
    if (data.workspace != null && jsonLength(data.workspace) > MAX_WORKSPACE_CHARS) return false;
    for (const key of ['cursorPos', 'cursorLine', 'cursorColumn', 'selectionFrom', 'selectionTo', 'docLength', 'lineCount', 'startLine', 'endLine', 'nextStartLine']) {
      if (data[key] != null && (!Number.isInteger(data[key]) || data[key] < 0)) return false;
    }
    return ['truncated', 'selectionTruncated'].every(key => data[key] == null || typeof data[key] === 'boolean');
  }

  function validPreviewResponse(data) {
    if (!exactObject(data, ['error', 'dataUrl', 'width', 'height', 'mimeType'])) return false;
    if (data.error != null) return typeof data.error === 'string' && data.error.length <= 2_000;
    return typeof data.dataUrl === 'string' && data.dataUrl.length <= MAX_PREVIEW_CHARS &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(data.dataUrl) &&
      Number.isInteger(data.width) && data.width > 0 && data.width <= 4096 &&
      Number.isInteger(data.height) && data.height > 0 && data.height <= 4096 &&
      (data.mimeType == null || ['image/png', 'image/jpeg', 'image/webp'].includes(data.mimeType));
  }

  function validDiagnosticsResponse(data) {
    if (!exactObject(data, ['diagnostics', 'error', 'truncated', 'totalCount']) || jsonLength(data) > MAX_DIAGNOSTICS_CHARS) return false;
    if (!Array.isArray(data.diagnostics) || data.diagnostics.length > MAX_DIAGNOSTICS) return false;
    if (data.error != null && (typeof data.error !== 'string' || data.error.length > 2_000)) return false;
    if (data.truncated != null && typeof data.truncated !== 'boolean') return false;
    if (data.totalCount != null && (!Number.isInteger(data.totalCount) || data.totalCount < data.diagnostics.length)) return false;
    return data.diagnostics.every(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !exactObject(item, ['severity', 'message', 'line', 'column', 'kind', 'original', 'suggestion'])) return false;
      if (typeof item.message !== 'string' || item.message.length > 2_000) return false;
      if (item.severity != null && (typeof item.severity !== 'string' || item.severity.length > 16)) return false;
      if (item.kind != null && (typeof item.kind !== 'string' || item.kind.length > 32)) return false;
      if (item.original != null && (typeof item.original !== 'string' || item.original.length > 500)) return false;
      if (item.suggestion != null && (typeof item.suggestion !== 'string' || item.suggestion.length > 500)) return false;
      return ['line', 'column'].every(key => item[key] == null || (Number.isInteger(item[key]) && item[key] >= 0));
    });
  }

  function exactObject(value, allowed) {
    const permitted = new Set(allowed);
    return Object.keys(value).every(key => permitted.has(key));
  }

  function jsonLength(value) {
    try { return JSON.stringify(value).length; } catch { return Infinity; }
  }

  function validChanges(changes, textLength) {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 128) return false;
    let insertedChars = 0;
    let previousTo = 0;
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(field => !['from', 'to', 'insert'].includes(field))) return false;
      if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to > textLength || typeof change.insert !== 'string') return false;
      if (index > 0 && change.from < previousTo) return false;
      previousTo = change.to;
      insertedChars += change.insert.length;
      if (insertedChars > 1_000_000) return false;
    }
    return true;
  }

  function validDiffPreview(preview) {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview) || Object.keys(preview).some(field => !['kind', 'fileLabel', 'additions', 'deletions', 'hunks'].includes(field))) return false;
    if (preview.kind !== 'unified-diff' || typeof preview.fileLabel !== 'string' || !preview.fileLabel || preview.fileLabel.length > 240) return false;
    if (!Number.isInteger(preview.additions) || preview.additions < 0 || !Number.isInteger(preview.deletions) || preview.deletions < 0) return false;
    if (!Array.isArray(preview.hunks) || preview.hunks.length === 0 || preview.hunks.length > 256) return false;
    let rowCount = 0;
    let textChars = 0;
    for (const hunk of preview.hunks) {
      if (!hunk || typeof hunk !== 'object' || Array.isArray(hunk) || Object.keys(hunk).some(field => !['oldStart', 'oldLines', 'newStart', 'newLines', 'rows'].includes(field))) return false;
      if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(value => Number.isInteger(value) && value >= 0) || !Array.isArray(hunk.rows) || hunk.rows.length === 0) return false;
      for (const row of hunk.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(field => !['kind', 'oldLine', 'newLine', 'text'].includes(field))) return false;
        if (!['context', 'delete', 'insert'].includes(row.kind) || typeof row.text !== 'string') return false;
        if (row.oldLine != null && (!Number.isInteger(row.oldLine) || row.oldLine < 1)) return false;
        if (row.newLine != null && (!Number.isInteger(row.newLine) || row.newLine < 1)) return false;
        if ((row.kind === 'insert' && row.oldLine != null) || (row.kind === 'delete' && row.newLine != null)) return false;
        rowCount += 1;
        textChars += row.text.length;
        if (rowCount > 5_000 || textChars > 512_000) return false;
      }
    }
    return preview.additions + preview.deletions > 0;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
