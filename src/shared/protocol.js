/**
 * Internal extension protocol. Every cross-context message uses the envelope
 * `{ type, requestId?, runId?, payload }` and is validated at the boundary.
 * Keep this module pure so it can be imported by Node tests, the service
 * worker, and the side panel.
 */

export const PROTOCOL = Object.freeze({
  RESPONSE: 'PROTOCOL_RESPONSE',

  LOAD_SETTINGS: 'LOAD_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  LOAD_THEME: 'LOAD_THEME',
  SAVE_THEME: 'SAVE_THEME',
  SESSION_LIST: 'SESSION_LIST',
  SESSION_CREATE: 'SESSION_CREATE',
  SESSION_GET: 'SESSION_GET',
  SESSION_UPDATE: 'SESSION_UPDATE',
  SESSION_DELETE: 'SESSION_DELETE',
  SESSION_LIST_ALL_GROUPED: 'SESSION_LIST_ALL_GROUPED',
  SESSION_DELETE_BY_PROJECT: 'SESSION_DELETE_BY_PROJECT',
  SESSION_IMPORT: 'SESSION_IMPORT',
  SESSION_EXPORT: 'SESSION_EXPORT',
  SESSION_STORAGE_STATUS: 'SESSION_STORAGE_STATUS',
  EDIT_CHECKPOINT_REVERT: 'EDIT_CHECKPOINT_REVERT',
  DOCUMENT_SNAPSHOT_LIST: 'DOCUMENT_SNAPSHOT_LIST',
  DOCUMENT_SNAPSHOT_PREVIEW: 'DOCUMENT_SNAPSHOT_PREVIEW',
  DOCUMENT_SNAPSHOT_RESTORE: 'DOCUMENT_SNAPSHOT_RESTORE',
  DOCUMENT_SNAPSHOT_DELETE: 'DOCUMENT_SNAPSHOT_DELETE',
  OPEN_PROJECT_TAB: 'OPEN_PROJECT_TAB',
  LOAD_CUSTOM_TOOLS: 'LOAD_CUSTOM_TOOLS',
  SAVE_CUSTOM_TOOLS: 'SAVE_CUSTOM_TOOLS',
  LOAD_MCP_SERVERS: 'LOAD_MCP_SERVERS',
  SAVE_MCP_SERVERS: 'SAVE_MCP_SERVERS',
  PROBE_MCP_SERVER: 'PROBE_MCP_SERVER',
  GET_EDITOR_CONTEXT: 'GET_EDITOR_CONTEXT',
  GET_PREVIEW: 'GET_PREVIEW',
  GET_DIAGNOSTICS: 'GET_DIAGNOSTICS',
  GENERATE_SESSION_TITLE: 'GENERATE_SESSION_TITLE',

  AI_STREAM_START: 'AI_STREAM_START',
  AI_STREAM_CANCEL: 'AI_STREAM_CANCEL',
  AI_RUN_STATUS: 'AI_RUN_STATUS',
  AI_STREAM_BATCH: 'AI_STREAM_BATCH',
  AI_STREAM_DONE: 'AI_STREAM_DONE',
  AI_STREAM_CANCELLED: 'AI_STREAM_CANCELLED',
  AI_STREAM_ERROR: 'AI_STREAM_ERROR',
  AI_TOOL_CALLS: 'AI_TOOL_CALLS',
  AI_TOOL_RESULT: 'AI_TOOL_RESULT',
  AI_TOOL_PREFLIGHT_WAITING: 'AI_TOOL_PREFLIGHT_WAITING',
  AI_TOOL_PREFLIGHT_READY: 'AI_TOOL_PREFLIGHT_READY',
  AI_TOOL_PREFLIGHT_RESOLVE: 'AI_TOOL_PREFLIGHT_RESOLVE',
  AI_TOOL_APPROVAL_REQUIRED: 'AI_TOOL_APPROVAL_REQUIRED',
  AI_TOOL_APPROVAL_RESOLVE: 'AI_TOOL_APPROVAL_RESOLVE',

  ACTIVE_TAB_CHANGED: 'ACTIVE_TAB_CHANGED',
  QUICK_ATTACH_SELECTION: 'QUICK_ATTACH_SELECTION',
  QUICK_ATTACH_IMAGE_PREVIEW: 'QUICK_ATTACH_IMAGE_PREVIEW',
  QUICK_ATTACH_DRAIN: 'QUICK_ATTACH_DRAIN',

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
  PAGE_BRIDGE_READY: 'PAGE_BRIDGE_READY'
});

const RUN_TYPES = new Set([
  PROTOCOL.AI_STREAM_START,
  PROTOCOL.AI_STREAM_CANCEL,
  PROTOCOL.AI_RUN_STATUS,
  PROTOCOL.AI_STREAM_BATCH,
  PROTOCOL.AI_STREAM_DONE,
  PROTOCOL.AI_STREAM_CANCELLED,
  PROTOCOL.AI_STREAM_ERROR,
  PROTOCOL.AI_TOOL_CALLS,
  PROTOCOL.AI_TOOL_RESULT,
  PROTOCOL.AI_TOOL_PREFLIGHT_WAITING,
  PROTOCOL.AI_TOOL_PREFLIGHT_READY,
  PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE,
  PROTOCOL.AI_TOOL_APPROVAL_REQUIRED,
  PROTOCOL.AI_TOOL_APPROVAL_RESOLVE,
  PROTOCOL.PAGE_SHOW_EDIT_PREVIEW,
  PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW,
  PROTOCOL.PAGE_APPLY_EDIT,
  PROTOCOL.PAGE_CANCEL_REQUEST
]);

const REQUEST_TYPES = new Set([
  PROTOCOL.LOAD_SETTINGS,
  PROTOCOL.SAVE_SETTINGS,
  PROTOCOL.LOAD_THEME,
  PROTOCOL.SAVE_THEME,
  PROTOCOL.SESSION_LIST,
  PROTOCOL.SESSION_CREATE,
  PROTOCOL.SESSION_GET,
  PROTOCOL.SESSION_UPDATE,
  PROTOCOL.SESSION_DELETE,
  PROTOCOL.SESSION_LIST_ALL_GROUPED,
  PROTOCOL.SESSION_DELETE_BY_PROJECT,
  PROTOCOL.SESSION_IMPORT,
  PROTOCOL.SESSION_EXPORT,
  PROTOCOL.SESSION_STORAGE_STATUS,
  PROTOCOL.EDIT_CHECKPOINT_REVERT,
  PROTOCOL.DOCUMENT_SNAPSHOT_LIST,
  PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW,
  PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE,
  PROTOCOL.DOCUMENT_SNAPSHOT_DELETE,
  PROTOCOL.OPEN_PROJECT_TAB,
  PROTOCOL.LOAD_CUSTOM_TOOLS,
  PROTOCOL.SAVE_CUSTOM_TOOLS,
  PROTOCOL.LOAD_MCP_SERVERS,
  PROTOCOL.SAVE_MCP_SERVERS,
  PROTOCOL.PROBE_MCP_SERVER,
  PROTOCOL.GET_EDITOR_CONTEXT,
  PROTOCOL.GET_PREVIEW,
  PROTOCOL.GET_DIAGNOSTICS,
  PROTOCOL.GENERATE_SESSION_TITLE,
  PROTOCOL.AI_STREAM_START,
  PROTOCOL.AI_STREAM_CANCEL,
  PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE,
  PROTOCOL.AI_TOOL_APPROVAL_RESOLVE,
  PROTOCOL.QUICK_ATTACH_SELECTION,
  PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW,
  PROTOCOL.QUICK_ATTACH_DRAIN,
  PROTOCOL.PAGE_GET_CONTEXT,
  PROTOCOL.PAGE_GET_PREVIEW,
  PROTOCOL.PAGE_GET_DIAGNOSTICS,
  PROTOCOL.PAGE_GET_PROBE,
  PROTOCOL.PAGE_CANCEL_REQUEST,
  PROTOCOL.PAGE_SHOW_EDIT_PREVIEW,
  PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW,
  PROTOCOL.PAGE_APPLY_EDIT
]);

const EVENT_TYPES = new Set(Object.values(PROTOCOL).filter(type =>
  type !== PROTOCOL.RESPONSE && !REQUEST_TYPES.has(type)
));

export const MESSAGE_REGISTRY = Object.freeze(
  Object.entries(PROTOCOL).map(([key, type]) => Object.freeze({
    key,
    type,
    kind: type === PROTOCOL.RESPONSE ? 'response' : REQUEST_TYPES.has(type) ? 'request' : 'event',
    runScoped: RUN_TYPES.has(type)
  }))
);

const TYPE_SET = new Set(Object.values(PROTOCOL));

export function createRequestId(prefix = 'req') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

export function createRunId() {
  return createRequestId('run');
}

export function buildEnvelope(type, payload = {}, options = {}) {
  const out = { type, payload: payload && typeof payload === 'object' ? payload : {} };
  if (options.requestId) out.requestId = String(options.requestId);
  if (options.runId) out.runId = String(options.runId);
  return out;
}

export function buildRequest(type, payload = {}, options = {}) {
  return buildEnvelope(type, payload, {
    requestId: options.requestId || createRequestId(),
    runId: options.runId
  });
}

export function buildRunEvent(type, runId, payload = {}) {
  return buildEnvelope(type, payload, { runId });
}

export function successResponse(requestId, data = null, runId = null) {
  return buildEnvelope(PROTOCOL.RESPONSE, { ok: true, data }, { requestId, runId });
}

export function errorResponse(requestId, error, runId = null) {
  const normalized = typeof error === 'string'
    ? { code: 'INTERNAL_ERROR', message: error }
    : {
        code: String(error?.code || 'INTERNAL_ERROR'),
        message: String(error?.message || 'Unknown error'),
        ...(error?.details == null ? {} : { details: error.details })
      };
  return buildEnvelope(PROTOCOL.RESPONSE, { ok: false, error: normalized }, { requestId, runId });
}

export function unwrapResponse(message) {
  const checked = validateEnvelope(message, { expectedType: PROTOCOL.RESPONSE });
  if (!checked.ok) throw new Error(checked.error.message);
  if (!checked.value.payload.ok) {
    const err = new Error(checked.value.payload.error?.message || 'Request failed');
    err.code = checked.value.payload.error?.code || 'REQUEST_FAILED';
    err.details = checked.value.payload.error?.details;
    throw err;
  }
  return checked.value.payload.data;
}

export function validateEnvelope(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return invalid('INVALID_ENVELOPE', 'Message must be an object');
  }
  if (typeof message.type !== 'string' || !TYPE_SET.has(message.type)) {
    return invalid('UNKNOWN_MESSAGE_TYPE', 'Unknown message type');
  }
  if (options.expectedType && message.type !== options.expectedType) {
    return invalid('UNEXPECTED_MESSAGE_TYPE', `Expected ${options.expectedType}`);
  }
  if (options.allowedTypes && !options.allowedTypes.has(message.type)) {
    return invalid('DISALLOWED_MESSAGE_TYPE', `Message type ${message.type} is not accepted here`);
  }
  if (REQUEST_TYPES.has(message.type) || message.type === PROTOCOL.RESPONSE) {
    if (typeof message.requestId !== 'string' || !message.requestId.trim()) {
      return invalid('INVALID_REQUEST_ID', `${message.type} requires a requestId`);
    }
  }
  if (RUN_TYPES.has(message.type)) {
    if (typeof message.runId !== 'string' || !message.runId.trim()) {
      return invalid('INVALID_RUN_ID', `${message.type} requires a runId`);
    }
  }
  if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
    return invalid('INVALID_PAYLOAD', 'Message payload must be an object');
  }
  const payload = validateMessagePayload(message.type, message.payload);
  if (!payload.ok) return payload;
  return { ok: true, value: message };
}

/** Validate exact top-level payload fields and the boundary-relevant shape. */
export function validateMessagePayload(type, payload) {
  let checked;
  switch (type) {
    case PROTOCOL.RESPONSE:
      checked = exactFields(payload, ['ok', 'data', 'error'], ['ok']);
      if (!checked.ok) return checked;
      if (typeof payload.ok !== 'boolean') return invalid('INVALID_RESPONSE', 'Response ok must be a boolean', '$.payload.ok');
      if (payload.ok) {
        if (!Object.hasOwn(payload, 'data') || Object.hasOwn(payload, 'error')) return invalid('INVALID_RESPONSE', 'Successful response must contain data only', '$.payload');
      } else if (!isRecord(payload.error) || !nonEmpty(payload.error.code) || !nonEmpty(payload.error.message)) {
        return invalid('INVALID_RESPONSE', 'Failed response must contain a structured error', '$.payload.error');
      }
      return checked;

    case PROTOCOL.LOAD_SETTINGS:
    case PROTOCOL.LOAD_THEME:
    case PROTOCOL.SESSION_LIST_ALL_GROUPED:
    case PROTOCOL.SESSION_EXPORT:
    case PROTOCOL.SESSION_STORAGE_STATUS:
    case PROTOCOL.LOAD_CUSTOM_TOOLS:
    case PROTOCOL.LOAD_MCP_SERVERS:
    case PROTOCOL.AI_STREAM_CANCEL:
    case PROTOCOL.PAGE_GET_PROBE:
    case PROTOCOL.PAGE_BRIDGE_INIT:
    case PROTOCOL.PAGE_BRIDGE_READY:
    case PROTOCOL.PAGE_QUICK_SELECTION:
    case PROTOCOL.PAGE_QUICK_IMAGE_PREVIEW:
      return exactFields(payload, []);

    case PROTOCOL.AI_STREAM_DONE:
      checked = exactFields(payload, ['snapshot', 'snapshotWarning']);
      if (!checked.ok) return checked;
      if (payload.snapshot != null && !validPublicDocumentSnapshot(payload.snapshot)) return invalid('INVALID_DOCUMENT_SNAPSHOT', 'Completed-run snapshot metadata is invalid.', '$.payload.snapshot');
      return payload.snapshotWarning == null || (typeof payload.snapshotWarning === 'string' && payload.snapshotWarning.length <= 500)
        ? checked
        : invalid('INVALID_DOCUMENT_SNAPSHOT_WARNING', 'Completed-run snapshot warning is invalid.', '$.payload.snapshotWarning');

    case PROTOCOL.QUICK_ATTACH_SELECTION:
    case PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW:
      if (Object.keys(payload).length === 0) return exactFields(payload, []);
      checked = exactFields(payload, ['tabId', 'windowId', 'eventId'], ['tabId', 'windowId']);
      if (!checked.ok) return checked;
      return Number.isInteger(payload.tabId) && payload.tabId >= 0 && Number.isInteger(payload.windowId) && payload.windowId >= 0 && (payload.eventId == null || nonEmpty(payload.eventId))
        ? checked
        : invalid('INVALID_QUICK_ATTACH_SOURCE', 'Quick attachment requires non-negative tabId and windowId values.', '$.payload');
    case PROTOCOL.QUICK_ATTACH_DRAIN:
      checked = exactFields(payload, ['windowId'], ['windowId']);
      if (!checked.ok) return checked;
      return Number.isInteger(payload.windowId) && payload.windowId >= 0
        ? checked
        : invalid('INVALID_WINDOW_ID', 'windowId must be a non-negative integer', '$.payload.windowId');

    case PROTOCOL.SAVE_SETTINGS:
      checked = exactFields(payload, ['settings', 'fields', 'modelMutation'], ['settings']);
      if (!checked.ok) return checked;
      if (!isRecord(payload.settings)) return invalid('INVALID_SETTINGS', 'settings must be an object', '$.payload.settings');
      if (payload.fields != null && (!Array.isArray(payload.fields) || payload.fields.some(field => !['systemPrompt', 'models', 'activeModelId', 'maxHistoryMessages', 'autoNameModelId', 'editorApprovalMode', 'sendMessageShortcut'].includes(field)))) return invalid('INVALID_SETTINGS_FIELDS', 'settings fields are invalid', '$.payload.fields');
      if (payload.modelMutation != null && !validRegistryMutation(payload.modelMutation, { allowSelect: true })) return invalid('INVALID_MODEL_MUTATION', 'model mutation is invalid', '$.payload.modelMutation');
      return checked;
    case PROTOCOL.SAVE_THEME:
      checked = exactFields(payload, ['theme'], ['theme']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.theme) ? checked : invalid('INVALID_THEME', 'theme must be a non-empty string', '$.payload.theme');
    case PROTOCOL.SESSION_LIST:
    case PROTOCOL.SESSION_DELETE_BY_PROJECT:
    case PROTOCOL.OPEN_PROJECT_TAB:
      checked = exactFields(payload, ['projectId'], ['projectId']);
      if (!checked.ok) return checked;
      return typeof payload.projectId === 'string' ? checked : invalid('INVALID_PROJECT_ID', 'projectId must be a string', '$.payload.projectId');
    case PROTOCOL.SESSION_CREATE:
      checked = exactFields(payload, ['projectId', 'name'], ['projectId']);
      if (!checked.ok) return checked;
      if (typeof payload.projectId !== 'string' || (payload.name != null && typeof payload.name !== 'string')) return invalid('INVALID_SESSION_CREATE', 'Session projectId and name must be strings', '$.payload');
      return checked;
    case PROTOCOL.SESSION_GET:
    case PROTOCOL.SESSION_DELETE:
      checked = exactFields(payload, ['sessionId'], ['sessionId']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.sessionId) ? checked : invalid('INVALID_SESSION_ID', 'sessionId is required', '$.payload.sessionId');
    case PROTOCOL.SESSION_UPDATE:
      checked = exactFields(payload, ['sessionId', 'name', 'messages', 'userRenamed', 'autoName'], ['sessionId']);
      if (!checked.ok) return checked;
      if (!nonEmpty(payload.sessionId) || (payload.name != null && typeof payload.name !== 'string') || (payload.messages != null && !Array.isArray(payload.messages)) || (payload.userRenamed != null && typeof payload.userRenamed !== 'boolean') || (payload.autoName != null && typeof payload.autoName !== 'boolean')) {
        return invalid('INVALID_SESSION_UPDATE', 'Session update fields have invalid types', '$.payload');
      }
      if (payload.autoName === true && (typeof payload.name !== 'string' || payload.messages != null || payload.userRenamed != null)) return invalid('INVALID_SESSION_UPDATE', 'Automatic naming must update only the session name.', '$.payload');
      return checked;
    case PROTOCOL.SESSION_IMPORT:
      checked = exactFields(payload, ['exportData', 'records']);
      if (!checked.ok) return checked;
      if (!Object.hasOwn(payload, 'exportData') && !Object.hasOwn(payload, 'records')) return invalid('MISSING_PAYLOAD_FIELD', 'Session import requires exportData or records', '$.payload');
      if (!isContainer(payload.exportData ?? payload.records)) return invalid('INVALID_SESSION_IMPORT', 'Session import data must be an object or array', '$.payload');
      return checked;
    case PROTOCOL.EDIT_CHECKPOINT_REVERT:
      checked = exactFields(payload, ['checkpointId', 'tabId', 'projectId', 'sessionId'], ['checkpointId', 'tabId', 'projectId', 'sessionId']);
      if (!checked.ok) return checked;
      if (!nonEmpty(payload.checkpointId) || payload.checkpointId.length > 128) return invalid('INVALID_CHECKPOINT_ID', 'checkpointId is required', '$.payload.checkpointId');
      if (!Number.isInteger(payload.tabId) || payload.tabId < 0) return invalid('INVALID_TAB_ID', 'tabId must be a non-negative integer', '$.payload.tabId');
      if (!nonEmpty(payload.projectId)) return invalid('INVALID_PROJECT_ID', 'projectId is required', '$.payload.projectId');
      return nonEmpty(payload.sessionId) ? checked : invalid('INVALID_SESSION_ID', 'sessionId is required', '$.payload.sessionId');
    case PROTOCOL.DOCUMENT_SNAPSHOT_LIST:
      checked = exactFields(payload, ['tabId', 'projectId', 'sessionId'], ['tabId', 'projectId', 'sessionId']);
      if (!checked.ok) return checked;
      return validDocumentSnapshotScope(payload) ? checked : invalid('INVALID_DOCUMENT_SNAPSHOT_SCOPE', 'Document snapshot requests require an exact tab, project, and chat scope.', '$.payload');
    case PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW:
    case PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE:
    case PROTOCOL.DOCUMENT_SNAPSHOT_DELETE:
      checked = exactFields(payload, ['snapshotId', 'tabId', 'projectId', 'sessionId'], ['snapshotId', 'tabId', 'projectId', 'sessionId']);
      if (!checked.ok) return checked;
      if (!nonEmpty(payload.snapshotId) || payload.snapshotId.length > 128) return invalid('INVALID_DOCUMENT_SNAPSHOT_ID', 'snapshotId is required', '$.payload.snapshotId');
      return validDocumentSnapshotScope(payload) ? checked : invalid('INVALID_DOCUMENT_SNAPSHOT_SCOPE', 'Document snapshot requests require an exact tab, project, and chat scope.', '$.payload');
    case PROTOCOL.SAVE_CUSTOM_TOOLS:
      checked = exactFields(payload, ['tools', 'mutation'], ['tools']);
      if (!checked.ok) return checked;
      return Array.isArray(payload.tools) && (payload.mutation == null || validRegistryMutation(payload.mutation)) ? checked : invalid('INVALID_CUSTOM_TOOLS', 'tools or mutation is invalid', '$.payload');
    case PROTOCOL.SAVE_MCP_SERVERS:
      checked = exactFields(payload, ['servers', 'mutation'], ['servers']);
      if (!checked.ok) return checked;
      return Array.isArray(payload.servers) && (payload.mutation == null || validRegistryMutation(payload.mutation)) ? checked : invalid('INVALID_MCP_SERVERS', 'servers or mutation is invalid', '$.payload');
    case PROTOCOL.PROBE_MCP_SERVER:
      checked = exactFields(payload, ['server'], ['server']);
      if (!checked.ok) return checked;
      return isRecord(payload.server) ? checked : invalid('INVALID_MCP_SERVER', 'server must be an object', '$.payload.server');

    case PROTOCOL.GET_EDITOR_CONTEXT:
    case PROTOCOL.PAGE_GET_CONTEXT:
      checked = exactFields(payload, ['tabId', 'projection', 'startLine', 'endLine', 'maxChars']);
      if (!checked.ok) return checked;
      if (!validOptionalTabId(payload.tabId)) return invalid('INVALID_TAB_ID', 'tabId must be a non-negative integer', '$.payload.tabId');
      if (payload.projection != null && !['full', 'edit', 'numbered', 'identity'].includes(payload.projection)) return invalid('INVALID_CONTEXT_PROJECTION', 'Context projection is invalid', '$.payload.projection');
      if (payload.startLine != null && (!Number.isInteger(payload.startLine) || payload.startLine < 1)) return invalid('INVALID_CONTEXT_RANGE', 'startLine must be a positive integer', '$.payload.startLine');
      if (payload.endLine != null && (!Number.isInteger(payload.endLine) || payload.endLine < 1)) return invalid('INVALID_CONTEXT_RANGE', 'endLine must be a positive integer', '$.payload.endLine');
      if (payload.startLine != null && payload.endLine != null && payload.endLine < payload.startLine) return invalid('INVALID_CONTEXT_RANGE', 'endLine must not precede startLine', '$.payload.endLine');
      if (payload.maxChars != null && (!Number.isInteger(payload.maxChars) || payload.maxChars < 1 || payload.maxChars > 64_000)) return invalid('INVALID_CONTEXT_LIMIT', 'maxChars must be an integer from 1 to 64000', '$.payload.maxChars');
      return checked;
    case PROTOCOL.GET_DIAGNOSTICS:
    case PROTOCOL.PAGE_GET_DIAGNOSTICS:
      checked = exactFields(payload, ['tabId']);
      if (!checked.ok) return checked;
      return validOptionalTabId(payload.tabId) ? checked : invalid('INVALID_TAB_ID', 'tabId must be a non-negative integer', '$.payload.tabId');
    case PROTOCOL.GET_PREVIEW:
    case PROTOCOL.PAGE_GET_PREVIEW:
      checked = exactFields(payload, ['tabId', 'preferTypstCanvas', 'preferAssetImage']);
      if (!checked.ok) return checked;
      if (!validOptionalTabId(payload.tabId) || !validOptionalBoolean(payload.preferTypstCanvas) || !validOptionalBoolean(payload.preferAssetImage)) return invalid('INVALID_PREVIEW_REQUEST', 'Preview options have invalid types', '$.payload');
      return checked;
    case PROTOCOL.GENERATE_SESSION_TITLE:
      checked = exactFields(payload, ['modelConfig', 'messages'], ['modelConfig', 'messages']);
      if (!checked.ok) return checked;
      return isRecord(payload.modelConfig) && Array.isArray(payload.messages) ? checked : invalid('INVALID_TITLE_REQUEST', 'Title request requires modelConfig and messages', '$.payload');

    case PROTOCOL.AI_STREAM_START:
      checked = exactFields(payload, ['tabId', 'projectId', 'sessionId', 'messages', 'settings', 'modelConfig', 'attachments', 'activeEditorFile'], ['tabId', 'projectId', 'sessionId', 'messages']);
      if (!checked.ok) return checked;
      if (!Number.isInteger(payload.tabId) || payload.tabId < 0) return invalid('INVALID_TAB_ID', 'tabId must be a non-negative integer', '$.payload.tabId');
      if (!nonEmpty(payload.projectId)) return invalid('INVALID_PROJECT_ID', 'projectId is required', '$.payload.projectId');
      if (!nonEmpty(payload.sessionId)) return invalid('INVALID_SESSION_ID', 'sessionId is required', '$.payload.sessionId');
      if (!Array.isArray(payload.messages)) return invalid('INVALID_MESSAGES', 'messages must be an array', '$.payload.messages');
      if ((payload.settings != null && !isRecord(payload.settings)) || (payload.modelConfig != null && !isRecord(payload.modelConfig)) || (payload.attachments != null && !isRecord(payload.attachments))) return invalid('INVALID_RUN_START', 'Run settings, modelConfig, and attachments must be objects', '$.payload');
      if (payload.activeEditorFile != null && !validActiveEditorFile(payload.activeEditorFile)) return invalid('INVALID_ACTIVE_EDITOR_FILE', 'activeEditorFile is invalid', '$.payload.activeEditorFile');
      return checked;
    case PROTOCOL.AI_RUN_STATUS:
      checked = exactFields(payload, ['projectId', 'sessionId'], ['projectId', 'sessionId']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.projectId) && nonEmpty(payload.sessionId)
        ? checked
        : invalid('INVALID_RUN_STATUS', 'Run status requires projectId and sessionId', '$.payload');
    case PROTOCOL.AI_STREAM_BATCH:
      checked = exactFields(payload, ['items'], ['items']);
      if (!checked.ok) return checked;
      if (!Array.isArray(payload.items) || payload.items.length > 256 || payload.items.some(item => !isRecord(item) || !['content', 'reasoning'].includes(item.channel) || typeof item.text !== 'string')) return invalid('INVALID_STREAM_BATCH', 'Stream batch items are invalid', '$.payload.items');
      return checked;
    case PROTOCOL.AI_STREAM_CANCELLED:
    case PROTOCOL.AI_STREAM_ERROR:
      checked = exactFields(payload, ['code', 'message'], ['code', 'message']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.code) && typeof payload.message === 'string' ? checked : invalid('INVALID_RUN_ERROR', 'Run terminal error requires code and message', '$.payload');
    case PROTOCOL.AI_TOOL_CALLS:
      checked = exactFields(payload, ['calls'], ['calls']);
      if (!checked.ok) return checked;
      if (!Array.isArray(payload.calls) || payload.calls.length > 64 || payload.calls.some(call => !isRecord(call) || !nonEmpty(call.id) || !nonEmpty(call.name) || !isRecord(call.args))) return invalid('INVALID_TOOL_CALLS', 'Tool calls are invalid', '$.payload.calls');
      return checked;
    case PROTOCOL.AI_TOOL_RESULT:
      checked = exactFields(payload, ['callId', 'name', 'result'], ['callId', 'name', 'result']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.callId) && nonEmpty(payload.name) && isRecord(payload.result) ? checked : invalid('INVALID_TOOL_RESULT', 'Tool result fields are invalid', '$.payload');
    case PROTOCOL.AI_TOOL_PREFLIGHT_WAITING:
      checked = exactFields(payload, ['callId', 'name', 'missing', 'hint'], ['callId', 'name', 'missing', 'hint']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.callId) && nonEmpty(payload.name) && Array.isArray(payload.missing) && payload.missing.every(nonEmpty) && typeof payload.hint === 'string' ? checked : invalid('INVALID_PREFLIGHT', 'Preflight payload is invalid', '$.payload');
    case PROTOCOL.AI_TOOL_PREFLIGHT_READY:
      checked = exactFields(payload, ['callId'], ['callId']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.callId) ? checked : invalid('INVALID_CALL_ID', 'callId is required', '$.payload.callId');
    case PROTOCOL.AI_TOOL_PREFLIGHT_RESOLVE:
      checked = exactFields(payload, ['callId', 'action'], ['callId', 'action']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.callId) && ['retry', 'cancel'].includes(payload.action) ? checked : invalid('INVALID_PREFLIGHT_ACTION', 'Preflight action is invalid', '$.payload.action');
    case PROTOCOL.AI_TOOL_APPROVAL_REQUIRED:
      checked = exactFields(payload, ['callId', 'name', 'identity', 'effect', 'destination', 'arguments', 'argumentChars', 'argumentsTruncated', 'preview', 'previewNotice'], ['callId', 'name', 'identity', 'effect', 'destination', 'arguments', 'argumentChars', 'argumentsTruncated']);
      if (!checked.ok) return checked;
      if (!['callId', 'name', 'identity', 'effect', 'destination', 'arguments'].every(field => typeof payload[field] === 'string' && payload[field].length > 0)) return invalid('INVALID_APPROVAL', 'Approval payload is invalid', '$.payload');
      if (!Number.isInteger(payload.argumentChars) || payload.argumentChars < payload.arguments.length || typeof payload.argumentsTruncated !== 'boolean' || payload.argumentsTruncated !== (payload.argumentChars > payload.arguments.length)) return invalid('INVALID_APPROVAL', 'Approval argument summary metadata is invalid', '$.payload');
      if (payload.previewNotice != null && (typeof payload.previewNotice !== 'string' || payload.previewNotice.length > 500)) return invalid('INVALID_APPROVAL', 'Approval preview notice is invalid', '$.payload.previewNotice');
      return payload.preview == null || validDiffPreview(payload.preview) ? checked : invalid('INVALID_EDIT_PREVIEW', 'Edit preview is invalid', '$.payload.preview');
    case PROTOCOL.AI_TOOL_APPROVAL_RESOLVE:
      checked = exactFields(payload, ['callId', 'action'], ['callId', 'action']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.callId) && ['approve_once', 'allow_run', 'deny'].includes(payload.action) ? checked : invalid('INVALID_APPROVAL_ACTION', 'Approval action is invalid', '$.payload.action');
    case PROTOCOL.ACTIVE_TAB_CHANGED:
      checked = exactFields(payload, ['onTypst', 'url', 'tabId'], ['onTypst', 'url', 'tabId']);
      if (!checked.ok) return checked;
      return typeof payload.onTypst === 'boolean' && typeof payload.url === 'string' && (payload.tabId == null || (Number.isInteger(payload.tabId) && payload.tabId >= 0)) ? checked : invalid('INVALID_TAB_EVENT', 'Active-tab event is invalid', '$.payload');
    case PROTOCOL.PAGE_SHOW_EDIT_PREVIEW:
      checked = exactFields(payload, ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId', 'preview'], ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId', 'preview']);
      if (!checked.ok) return checked;
      return typeof payload.expectedText === 'string' && payload.expectedText.length <= 1_000_000 && nonEmpty(payload.expectedEditorToken) && payload.expectedEditorToken.length <= 200 && nonEmpty(payload.expectedFileLabel) && payload.expectedFileLabel.length <= 240 && validPreparedChanges(payload.changes, payload.expectedText.length) && nonEmpty(payload.callId) && validDiffPreview(payload.preview)
        ? checked
        : invalid('INVALID_PREPARED_EDIT', 'Prepared edit preview request is invalid', '$.payload');
    case PROTOCOL.PAGE_APPLY_EDIT:
      checked = exactFields(payload, ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId'], ['expectedText', 'expectedEditorToken', 'expectedFileLabel', 'changes', 'callId']);
      if (!checked.ok) return checked;
      return typeof payload.expectedText === 'string' && payload.expectedText.length <= 1_000_000 && nonEmpty(payload.expectedEditorToken) && payload.expectedEditorToken.length <= 200 && nonEmpty(payload.expectedFileLabel) && payload.expectedFileLabel.length <= 240 && validPreparedChanges(payload.changes, payload.expectedText.length) && nonEmpty(payload.callId)
        ? checked
        : invalid('INVALID_PREPARED_EDIT', 'Prepared edit request is invalid', '$.payload');
    case PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW:
      checked = exactFields(payload, ['callId'], ['callId']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.callId) ? checked : invalid('INVALID_CALL_ID', 'callId is required', '$.payload.callId');
    case PROTOCOL.PAGE_CANCEL_REQUEST:
      checked = exactFields(payload, ['targetRequestId'], ['targetRequestId']);
      if (!checked.ok) return checked;
      return nonEmpty(payload.targetRequestId) && payload.targetRequestId.length <= 200
        ? checked
        : invalid('INVALID_CANCEL_TARGET', 'targetRequestId is required', '$.payload.targetRequestId');
    default:
      return invalid('UNKNOWN_MESSAGE_TYPE', 'Unknown message type');
  }
}

export function validateRunStartEnvelope(message) {
  const base = validateEnvelope(message, { expectedType: PROTOCOL.AI_STREAM_START });
  if (!base.ok) return base;
  const p = message.payload;
  if (!Number.isInteger(p.tabId) || p.tabId < 0) return invalid('INVALID_TAB_ID', 'tabId must be a non-negative integer');
  if (!nonEmpty(p.projectId)) return invalid('INVALID_PROJECT_ID', 'projectId is required');
  if (!nonEmpty(p.sessionId)) return invalid('INVALID_SESSION_ID', 'sessionId is required');
  if (!Array.isArray(p.messages)) return invalid('INVALID_MESSAGES', 'messages must be an array');
  return base;
}

export function validateRunCancelEnvelope(message) {
  return validateEnvelope(message, { expectedType: PROTOCOL.AI_STREAM_CANCEL });
}

export function isRunEvent(type) {
  return RUN_TYPES.has(type) && !REQUEST_TYPES.has(type);
}

export function isRequestType(type) {
  return REQUEST_TYPES.has(type);
}

export function isEventType(type) {
  return EVENT_TYPES.has(type);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactFields(payload, allowed, required = []) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(payload).find(field => !allowedSet.has(field));
  if (unknown) return invalid('UNKNOWN_PAYLOAD_FIELD', `Unknown payload field: ${unknown}`, `$.payload.${unknown}`);
  const missing = required.find(field => !Object.hasOwn(payload, field));
  if (missing) return invalid('MISSING_PAYLOAD_FIELD', `Missing payload field: ${missing}`, `$.payload.${missing}`);
  return { ok: true, value: payload };
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isContainer(value) {
  return Array.isArray(value) || isRecord(value);
}

function validOptionalTabId(value) {
  return value == null || (Number.isInteger(value) && value >= 0);
}

function validOptionalBoolean(value) {
  return value == null || typeof value === 'boolean';
}

function validActiveEditorFile(value) {
  if (!isRecord(value)) return false;
  const allowed = new Set(['projectLabel', 'relativePath', 'basename', 'source', 'confidence']);
  if (Object.keys(value).some(key => !allowed.has(key))) return false;
  if (value.projectLabel != null && (typeof value.projectLabel !== 'string' || value.projectLabel.length > 160)) return false;
  if (!nonEmpty(value.relativePath) || value.relativePath.length > 240 || /[\0\r\n\\]/.test(value.relativePath)) return false;
  if (value.relativePath !== value.relativePath.trim() || value.relativePath.startsWith('/') || value.relativePath.includes('//') || /^[a-z][a-z0-9+.-]*:/i.test(value.relativePath)) return false;
  const segments = value.relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment !== segment.trim())) return false;
  if (!/\.[a-z0-9][a-z0-9+_-]{0,31}$/i.test(segments.at(-1))) return false;
  if (!nonEmpty(value.basename) || value.basename.length > 240 || value.basename !== segments.at(-1)) return false;
  if (!nonEmpty(value.source) || value.source.length > 64 || !/^[a-z0-9_+-]+$/i.test(value.source)) return false;
  return ['high', 'medium', 'low'].includes(value.confidence);
}

function validDocumentSnapshotScope(payload) {
  return Number.isInteger(payload.tabId) && payload.tabId >= 0 &&
    nonEmpty(payload.projectId) && payload.projectId.length <= 256 &&
    nonEmpty(payload.sessionId) && payload.sessionId.length <= 256;
}

function validPublicDocumentSnapshot(value) {
  if (!isRecord(value) || Object.keys(value).some(key => !['id', 'kind', 'projectId', 'fileLabel', 'title', 'createdAt', 'textLength', 'sessionId'].includes(key))) return false;
  if (!nonEmpty(value.id) || value.id.length > 128 || !['manual', 'automatic', 'rescue'].includes(value.kind)) return false;
  if (!nonEmpty(value.projectId) || value.projectId.length > 256 || !nonEmpty(value.fileLabel) || value.fileLabel.length > 240) return false;
  if (typeof value.title !== 'string' || value.title.length > 120 || !Number.isFinite(value.createdAt) || value.createdAt < 0) return false;
  if (!Number.isInteger(value.textLength) || value.textLength < 0 || value.textLength > 1_000_000) return false;
  return value.sessionId == null || (nonEmpty(value.sessionId) && value.sessionId.length <= 256);
}

function validRegistryMutation(value, { allowSelect = false } = {}) {
  if (!isRecord(value) || Object.keys(value).some(key => !['type', 'id', 'record', 'records'].includes(key))) return false;
  if (value.type === 'upsert') return isRecord(value.record) && nonEmpty(value.record.id);
  if (value.type === 'replace') return Array.isArray(value.records);
  if (['remove', 'toggle'].includes(value.type) || (allowSelect && value.type === 'select')) return nonEmpty(value.id);
  return false;
}

function validPreparedChanges(changes, textLength) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 128) return false;
  let insertedChars = 0;
  let previousTo = 0;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!isRecord(change) || Object.keys(change).some(field => !['from', 'to', 'insert'].includes(field))) return false;
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to > textLength || typeof change.insert !== 'string') return false;
    if (index > 0 && change.from < previousTo) return false;
    previousTo = change.to;
    insertedChars += change.insert.length;
    if (insertedChars > 1_000_000) return false;
  }
  return true;
}

function validDiffPreview(preview) {
  if (!isRecord(preview) || Object.keys(preview).some(field => !['kind', 'fileLabel', 'additions', 'deletions', 'hunks'].includes(field))) return false;
  if (preview.kind !== 'unified-diff' || !nonEmpty(preview.fileLabel) || preview.fileLabel.length > 240) return false;
  if (!Number.isInteger(preview.additions) || preview.additions < 0 || !Number.isInteger(preview.deletions) || preview.deletions < 0) return false;
  if (!Array.isArray(preview.hunks) || preview.hunks.length === 0 || preview.hunks.length > 256) return false;
  let rowCount = 0;
  let textChars = 0;
  for (const hunk of preview.hunks) {
    if (!isRecord(hunk) || Object.keys(hunk).some(field => !['oldStart', 'oldLines', 'newStart', 'newLines', 'rows'].includes(field))) return false;
    if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(value => Number.isInteger(value) && value >= 0)) return false;
    if (!Array.isArray(hunk.rows) || hunk.rows.length === 0) return false;
    for (const row of hunk.rows) {
      if (!isRecord(row) || Object.keys(row).some(field => !['kind', 'oldLine', 'newLine', 'text'].includes(field))) return false;
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

function invalid(code, message, path = '$') {
  return { ok: false, error: { code, path, message } };
}
