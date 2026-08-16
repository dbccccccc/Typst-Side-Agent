import { LIMITS } from '../shared/constants.js';
import { isEditCheckpointToolName, normalizePublicEditCheckpoint } from '../shared/edit-checkpoint.js';
import { normalizeEditorStateUpdate } from '../shared/document-snapshot.js';
import { normalizeActiveEditorFile } from '../shared/active-file.js';

const MAX_MESSAGES = 1_000;
const MAX_MESSAGE_CHARS = 256_000;
const MAX_SEGMENTS = 256;
const RESPONSE_STATUSES = new Set(['complete', 'incomplete']);

export function normalizeImportedSessionRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return failure('Record must be an object.');
  const messages = normalizeSessionMessages(record.messages, { imported: true });
  if (!messages.ok) return messages;
  return {
    ok: true,
    value: {
      id: cleanId(record.id),
      projectId: boundedString(record.projectId, 256),
      name: boundedString(record.name || 'Imported chat', 200),
      messages: messages.value,
      createdAt: finiteTimestamp(record.createdAt),
      updatedAt: finiteTimestamp(record.updatedAt)
    }
  };
}

export function normalizeSessionMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return failure('Session messages must be an array.');
  if (messages.length > MAX_MESSAGES) return failure(`Session exceeds ${MAX_MESSAGES} messages.`);
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const normalized = normalizeMessage(messages[i], options);
    if (!normalized.ok) return failure(`Message ${i + 1}: ${normalized.error.message}`);
    out.push(normalized.value);
  }
  return { ok: true, value: out };
}

export function summarizeToolResultForHistory(name, result, options = {}) {
  if (!result || typeof result !== 'object') return { ok: false, error: boundedString(result, 300) || 'No result' };
  if (name === 'read_document') {
    return {
      ok: result.ok !== false,
      doc_chars: finiteNumber(result.doc_chars),
      approx_line_count: finiteNumber(result.approx_line_count),
      start_line: finiteNumber(result.start_line),
      end_line: finiteNumber(result.end_line),
      truncated: !!result.truncated,
      ...(result.error ? { error: boundedString(result.error, 500) } : {})
    };
  }
  if (name === 'read_diagnostics') {
    return {
      ok: result.ok !== false,
      error_count: finiteNumber(result.error_count) || 0,
      warning_count: finiteNumber(result.warning_count) || 0,
      spelling_count: finiteNumber(result.spelling_count) || 0,
      status_count: finiteNumber(result.status_count) || 0,
      total_count: finiteNumber(result.total_count) || 0,
      truncated: !!result.truncated,
      diagnostics: Array.isArray(result.diagnostics)
        ? result.diagnostics.slice(0, 8).map(d => ({
            severity: boundedString(d?.severity, 16),
            kind: boundedString(d?.kind, 16),
            line: finiteNumber(d?.line),
            column: finiteNumber(d?.column),
            message: boundedString(d?.message, 300)
          }))
        : []
    };
  }
  const editCheckpoint = isEditCheckpointToolName(name)
    ? normalizePublicEditCheckpoint(result.editCheckpoint, options)
    : null;
  if (editCheckpoint) {
    return {
      ok: result.ok !== false,
      edits_applied: finiteNumber(result.edits_applied) || 0,
      reviewed_diff: !!result.reviewed_diff,
      editCheckpoint,
      ...(result.warning ? { warning: boundedString(result.warning, 500) } : {}),
      ...(result.error ? { error: boundedString(result.error, 500) } : {})
    };
  }
  const text = safeJson(result);
  return {
    ok: result.ok !== false,
    summary: text.length > LIMITS.MAX_PERSISTED_TOOL_RESULT_CHARS
      ? text.slice(0, LIMITS.MAX_PERSISTED_TOOL_RESULT_CHARS) + '…'
      : text
  };
}

export function minimizeMessagesForStorage(messages) {
  const normalized = normalizeSessionMessages(messages);
  if (!normalized.ok) return normalized;
  return { ok: true, value: normalized.value.map(minimizeMessage) };
}

function normalizeMessage(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return failure('Message must be an object.');
  if (message.role !== 'user' && message.role !== 'assistant') return failure('Only user and assistant display messages are allowed.');
  if (message.content != null && typeof message.content !== 'string') return failure('Message content must be a string.');
  const content = message.content || '';
  if (content.length > MAX_MESSAGE_CHARS) return failure('Message text exceeds the supported length.');
  const out = { role: message.role, content };
  if (message.role === 'user' && message.activeEditorFile != null) {
    const activeEditorFile = normalizeActiveEditorFile(message.activeEditorFile);
    if (activeEditorFile) out.activeEditorFile = activeEditorFile;
  }
  if (message.editorStateUpdates != null) {
    if (!Array.isArray(message.editorStateUpdates) || message.editorStateUpdates.length > 16) return failure('Editor state updates must be a bounded array.');
    const updates = message.editorStateUpdates
      .map(update => normalizeEditorStateUpdate(update, options))
      .filter(Boolean);
    if (updates.length) out.editorStateUpdates = updates;
  }
  if (message.role === 'user' && message.sentAttachments != null) {
    if (!message.sentAttachments || typeof message.sentAttachments !== 'object' || Array.isArray(message.sentAttachments)) return failure('Sent attachments must be an object.');
    out.sentAttachments = normalizeSentAttachments(message.sentAttachments);
  }
  if (message.role === 'assistant') {
    if (message.responseStatus != null && !RESPONSE_STATUSES.has(message.responseStatus)) {
      return failure('Assistant response status is invalid.');
    }
    if (!options.imported && RESPONSE_STATUSES.has(message.responseStatus)) {
      out.responseStatus = message.responseStatus;
    }
    if (message.reasoning != null && typeof message.reasoning !== 'string') return failure('Assistant reasoning must be a string.');
    if (typeof message.reasoning === 'string') {
      if (message.reasoning.length > MAX_MESSAGE_CHARS) return failure('Assistant reasoning exceeds the supported length.');
      out.reasoning = message.reasoning;
    }
    if (Array.isArray(message.segments)) {
      if (message.segments.length > MAX_SEGMENTS) return failure('Assistant message has too many display segments.');
      out.segments = [];
      for (const segment of message.segments) {
        const normalized = normalizeSegment(segment, options);
        if (!normalized.ok) return normalized;
        out.segments.push(normalized.value);
      }
    } else if (message.segments != null) {
      return failure('Assistant segments must be an array.');
    }
    if (Array.isArray(message.toolCalls)) {
      if (message.toolCalls.length > 128) return failure('Assistant message has too many tool calls.');
      out.toolCalls = [];
      for (const call of message.toolCalls) {
        const normalized = normalizeToolCall(call);
        if (!normalized.ok) return normalized;
        out.toolCalls.push(normalized.value);
      }
    } else if (message.toolCalls != null) {
      return failure('Assistant tool calls must be an array.');
    }
  }
  return { ok: true, value: out };
}

function normalizeSegment(segment, options = {}) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return failure('Assistant segment must be an object.');
  if (segment.type === 'text' || segment.type === 'reasoning') {
    if (typeof segment.content !== 'string') return failure('Text and reasoning segment content must be a string.');
    if (segment.content.length > MAX_MESSAGE_CHARS) return failure('Assistant segment exceeds the supported length.');
    return { ok: true, value: { type: segment.type, content: segment.content } };
  }
  if (segment.type !== 'tools' || !Array.isArray(segment.calls)) return failure('Assistant segment type is unsupported.');
  if (segment.calls.length > 128) return failure('Assistant tool segment has too many calls.');
  const calls = [];
  for (const call of segment.calls) {
    const normalized = normalizeToolCall(call);
    if (!normalized.ok) return normalized;
    calls.push(normalized.value);
  }
  const results = {};
  for (const call of calls) results[call.id] = summarizeToolResultForHistory(call.name, segment.results?.[call.id], options);
  return { ok: true, value: { type: 'tools', calls, results } };
}

function normalizeToolCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return failure('Tool call must be an object.');
  const name = boundedString(call.name || call.function?.name, 128);
  const id = boundedString(call.id, 128);
  if (!name || !id || !/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9._:-]+$/.test(id)) return failure('Tool call id or name is invalid.');
  let args = call.args;
  if (!args && typeof call.function?.arguments === 'string') {
    try { args = JSON.parse(call.function.arguments); } catch { return failure('Tool-call arguments are not valid JSON.'); }
  }
  if (args != null && (!args || typeof args !== 'object' || Array.isArray(args))) return failure('Tool-call arguments must be an object.');
  if (safeJson(args || {}).length > 16_000) return failure('Tool-call arguments exceed the supported length.');
  const normalizedArgs = boundedJsonObject(args, 16_000);
  return { ok: true, value: { id, name, args: normalizedArgs } };
}

function normalizeSentAttachments(sent) {
  const out = {};
  if (Array.isArray(sent.selections)) {
    out.selections = sent.selections.slice(0, 16).map(s => ({
      text: boundedString(s?.text, 32_000),
      ...(boundedString(s?.fileLabel, 240) ? { fileLabel: boundedString(s.fileLabel, 240) } : {})
    })).filter(s => s.text);
  }
  if (Array.isArray(sent.previews)) {
    out.previews = sent.previews.slice(0, LIMITS.MAX_PERSISTED_PREVIEWS_PER_MESSAGE).map(p => {
      const dataUrl = typeof p?.dataUrl === 'string' ? p.dataUrl : '';
      if (p?.thumbnail === true && isAllowedImageDataUrl(dataUrl) && dataUrl.length <= LIMITS.MAX_PERSISTED_PREVIEW_CHARS) {
        return {
          dataUrl,
          width: boundedDimension(p.width),
          height: boundedDimension(p.height),
          mimeType: boundedString(p.mimeType || dataUrl.slice(5, dataUrl.indexOf(';')), 32),
          thumbnail: true
        };
      }
      return { omitted: true, reason: boundedString(p?.reason, 300) || 'Preview omitted from stored history to limit local retention.' };
    });
  }
  // Version-1 display-only compatibility. Never forwarded as new model context.
  if (sent.document || sent.legacyDocument) out.legacyDocument = true;
  const legacyDiagnostics = sent.diagnosticsCount ?? sent.legacyDiagnosticsCount;
  if (legacyDiagnostics) out.legacyDiagnosticsCount = Math.max(0, Math.min(10_000, Number(legacyDiagnostics) || 0));
  return out;
}

function minimizeMessage(message) {
  if (message.role !== 'assistant' || !Array.isArray(message.segments)) return message;
  return {
    ...message,
    segments: message.segments.map(segment => {
      if (segment.type !== 'tools') return segment;
      const results = {};
      for (const call of segment.calls || []) results[call.id] = summarizeToolResultForHistory(call.name, segment.results?.[call.id]);
      return { ...segment, results };
    })
  };
}

function isAllowedImageDataUrl(value) {
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

function boundedJsonObject(value, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const text = safeJson(value);
  if (text.length > max) return { omitted: true };
  try { return JSON.parse(text); } catch { return {}; }
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ error: 'Unserializable result' }); }
}

function cleanId(value) {
  const id = boundedString(value, 128);
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function boundedString(value, max) {
  return String(value ?? '').slice(0, max);
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function boundedDimension(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 4096) : null;
}

function failure(message) {
  return { ok: false, error: { code: 'INVALID_SESSION_RECORD', path: '$', message } };
}
