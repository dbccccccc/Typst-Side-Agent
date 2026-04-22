import { DEFAULT_SYSTEM_PROMPT, LIMITS, isReasoningEffortDefault } from '../shared/constants.js';

/**
 * Build the system message and attachment descriptions for a turn.
 *
 * @param {Object} opts
 * @param {Object} opts.settings
 * @param {Object} opts.attachments
 * @param {Object|null} opts.modelConfig
 * @param {Array}  opts.customTools      - Enabled custom tools (we list their names).
 * @param {Array}  opts.mcpServers       - Enabled MCP servers (we list their names).
 */
export function buildSystemMessage({
  settings,
  attachments,
  modelConfig,
  customTools = [],
  mcpServers = []
}) {
  const visionEnabled = !!modelConfig?.supportsVision;
  const prompt = (settings.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
  const parts = [prompt];

  // ---- External capabilities surface ----
  const capLines = [];
  if (customTools.length > 0) {
    capLines.push(`Custom tools available: ${customTools.map(t => t.name).join(', ')}.`);
  }
  if (mcpServers.length > 0) {
    const groups = mcpServers.map(s => {
      const names = (s.toolNames || []).slice(0, 8).join(', ') || '(no tools cached)';
      return `${s.name} → ${names}`;
    });
    capLines.push(`MCP servers connected: ${groups.join(' | ')}. MCP tools are namespaced as mcp__<server>__<tool>.`);
  }
  if (capLines.length > 0) {
    parts.push('# Extra tools\n\n' + capLines.join('\n'));
  }

  // ---- Document snapshot ----
  if (attachments.document) {
    const d = attachments.document;
    const numbered = typeof d.numberedFullText === 'string' && d.numberedFullText.length > 0;
    const src = numbered ? d.numberedFullText : (d.fullText || '');
    const truncated = src.length > LIMITS.MAX_DOC_CHARS_INITIAL;
    const text = src.slice(0, LIMITS.MAX_DOC_CHARS_INITIAL);
    const fence = numbered ? 'text' : 'typst';
    const cursorHint = d.cursorLine != null
      ? `Cursor: line ${d.cursorLine}, column ${d.cursorColumn ?? '—'}`
      : `Cursor index: ${d.cursorPos ?? 'unknown'}`;
    parts.push(
      `# Initial document snapshot (${d.docLength ?? (d.fullText || '').length} chars)\n` +
      (numbered ? 'Each line is shown as "  N|text"; the "N|" prefix is metadata.\n\n' : '') +
      '```' + fence + '\n' + text + (truncated ? '\n... (truncated; call read_document for more)' : '') + '\n```\n' +
      cursorHint + '\n\nCall read_document any time for a fresher snapshot.'
    );
    if (d.workspace && typeof d.workspace === 'object' && !d.workspace.error) {
      parts.push(
        '# typst.app workspace UI (heuristic)\n```json\n' +
        JSON.stringify(d.workspace, null, 2) +
        '\n```\n' + (d.workspace.notes || '')
      );
    } else if (d.workspace?.error) {
      parts.push('# typst.app workspace (detector error)\n' + d.workspace.error);
    }
  }

  // ---- Selections ----
  const selectionTexts = getSelectionTexts(attachments);
  selectionTexts.forEach((sel, i) => {
    const title = selectionTexts.length > 1 ? `Selected text (${i + 1})` : 'Selected text';
    parts.push(`# ${title}\n\`\`\`typst\n${sel}\n\`\`\``);
  });

  // ---- Diagnostics ----
  if (Array.isArray(attachments.diagnostics) && attachments.diagnostics.length > 0) {
    const lines = attachments.diagnostics.map(d => {
      const loc = d.line != null ? `line ${d.line}${d.column != null ? ':' + d.column : ''}` : '';
      const spell = d.original != null && d.suggestion != null
        ? ` (spelling: "${d.original}" → "${d.suggestion}")`
        : '';
      // Tag spelling rows explicitly so the model doesn't mistake them for
      // compiler warnings. kind='spelling' entries carry severity='info' and
      // originate from a different editor highlight layer (purple squiggle).
      const tag = d.kind === 'spelling' ? 'spelling' : (d.severity || 'info');
      return `- [${tag}]${loc ? ' ' + loc : ''}${spell}: ${d.message}`;
    });
    parts.push(`# Initial diagnostics (${attachments.diagnostics.length})\n${lines.join('\n')}\n\n[error] and [warning] come from the Typst compiler; [spelling] rows are advisory suggestions from typst.app's spellchecker — only apply a spelling fix when the user asked. Use read_diagnostics after edits for fresh diagnostics (same source as this block).`);
  }

  // ---- Vision note ----
  const previewUrls = getPreviewDataUrls(attachments);
  if (previewUrls.length > 0 && !visionEnabled) {
    parts.push(previewUrls.length > 1
      ? `(${previewUrls.length} preview screenshots were attached but the active model does not support vision.)`
      : '(A preview screenshot was captured but the active model does not support vision.)');
  }

  return { role: 'system', content: parts.join('\n\n') };
}

function getSelectionTexts(attachments) {
  if (!Array.isArray(attachments.selections) || attachments.selections.length === 0) return [];
  return attachments.selections
    .map(s => (typeof s === 'string' ? s : s?.selectedText) || '')
    .map(t => String(t).trim())
    .filter(Boolean);
}

function getPreviewDataUrls(attachments) {
  if (!Array.isArray(attachments.previews) || attachments.previews.length === 0) return [];
  return attachments.previews.map(p => p?.dataUrl).filter(u => typeof u === 'string' && u.length > 0);
}

/** True when the active model uses provider-side reasoning (replay may require `reasoning_content`). */
export function modelReasoningReplayEnabled(modelConfig) {
  const e = (modelConfig?.reasoningEffort || '').trim();
  return !!e && !isReasoningEffortDefault(e);
}

/** Strip UI-only fields from chat messages before sending to the API. */
function sanitizeChatMessagesForApi(chatMessages, modelConfig) {
  const thinkReplay = modelReasoningReplayEnabled(modelConfig);
  if (!Array.isArray(chatMessages)) return [];
  return chatMessages.map(m => {
    if (!m) return m;
    if (m.role === 'user') {
      return { role: 'user', content: typeof m.content === 'string' ? m.content : '' };
    }
    if (m.role === 'assistant') {
      const out = { role: 'assistant' };
      if (typeof m.content === 'string') out.content = m.content;
      else if (m.content == null) out.content = null;
      if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;

      const rc =
        typeof m.reasoning_content === 'string' ? m.reasoning_content
          : typeof m.reasoning === 'string' ? m.reasoning
          : null;
      if (rc != null && rc.length > 0) out.reasoning_content = rc;
      else if (thinkReplay && Array.isArray(out.tool_calls) && out.tool_calls.length > 0) {
        out.reasoning_content = '';
      }

      return out;
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    return m;
  });
}

/**
 * Build the full message array for the API. When history grows past
 * `maxHistoryMessages`, we collapse the oldest assistant/tool turns into a
 * compact summary stub so the model still has continuity without paying for
 * every token.
 */
export function buildMessages({ systemMessage, attachments, modelConfig, chatMessages, maxHistoryMessages }) {
  const visionEnabled = !!modelConfig?.supportsVision;
  const msgs = [systemMessage];

  const previewUrls = getPreviewDataUrls(attachments);
  if (previewUrls.length > 0 && visionEnabled) {
    const n = previewUrls.length;
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Attached: ${n} screenshot${n > 1 ? 's' : ''} from typst.app: Typst render and/or opened preview-column image.]`
        },
        ...previewUrls.map(url => ({ type: 'image_url', image_url: { url } }))
      ]
    });
  }

  const sanitized = sanitizeChatMessagesForApi(chatMessages, modelConfig);
  const trimmed = compactHistory(sanitized, maxHistoryMessages);
  msgs.push(...trimmed);

  return msgs;
}

/**
 * Drop the oldest messages once history exceeds the cap, replacing the dropped
 * span with a single short system note so context is preserved.
 */
export function compactHistory(messages, maxMessages) {
  if (!Array.isArray(messages) || messages.length <= maxMessages) return messages;
  const keep = Math.max(8, Math.floor(maxMessages * 0.75));
  const dropped = messages.length - keep;
  const recent = messages.slice(-keep);
  return [
    {
      role: 'system',
      content: `[Older conversation summarised: ${dropped} earlier message(s) were dropped to keep context size in check. Ask the user if you need details from before.]`
    },
    ...recent
  ];
}
