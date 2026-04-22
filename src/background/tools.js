import { LIMITS } from '../shared/constants.js';

/**
 * The built-in tools exposed to the model. Tool execution lives in agent.js
 * (read_document, read_diagnostics run in the background; the rest are forwarded
 * to the page).
 */
export const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_document',
      description:
        'Fetch the current Typst editor source plus a workspace UI snapshot (preview/asset path, file-tree hints). Numbered lines look like "  N|line text"; the "N|" prefix is metadata, not source. By default returns the start of the document up to max_chars. Pass start_line / end_line (1-indexed, inclusive) to read a specific range — the response includes approx_line_count so you can page further.',
      parameters: {
        type: 'object',
        properties: {
          start_line: {
            type: 'integer',
            description: 'First line to return (1-indexed, inclusive). When omitted, reading starts at line 1.'
          },
          end_line: {
            type: 'integer',
            description: 'Last line to return (1-indexed, inclusive). Clamped to the document length, so you can pass a generous upper bound. When omitted (and start_line is set), reads to end of document.'
          },
          max_chars: {
            type: 'integer',
            description: `Max characters of numbered source to return (default ${LIMITS.DEFAULT_READ_DOC_CHARS}, max ${LIMITS.MAX_READ_DOC_TOOL_CHARS}). Applied as a safety cap after any line-range slicing; ignored when start_line/end_line describe a small range.`
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_diagnostics',
      description:
        'Read current diagnostics the same way as + Add → Diagnostics: merged Improve-sidebar messages with CodeMirror lint positions. Each entry has severity ("error" | "warning" | "info") and kind ("typst" for compiler output, "spelling" for spellchecker suggestions). Response also includes disjoint error_count / warning_count / spelling_count so you can tell compiler problems from advisory spelling fixes at a glance. By default reads immediately; optionally wait so typst.app can recompile after your edits.',
      parameters: {
        type: 'object',
        properties: {
          delay_ms: {
            type: 'integer',
            description:
              'Milliseconds to wait before reading (default 0; max 4000). Use a short non-zero delay only if you just edited and need fresher compiler output.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_typst_docs',
      description:
        'Look up bundled Typst language / grammar reference docs. Call this whenever you are unsure about Typst syntax, a function signature, the right set/show rule, math symbol, or idiomatic pattern. Call with NO "topic" argument to get the topic index (id + one-line summary of each); call with "topic" (e.g. "markup", "math", "scripting", or "1".."12") to read that topic as markdown.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description:
              'Topic id or number. One of: syntax-basics, markup, math, scripting, types, styling, context, layout, visualize, model, data-loading, cheat-sheet. Also accepts "1".."12" or the file stem like "01-syntax-basics". Omit to list all topics.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_lines',
      description:
        'Replace an inclusive 1-indexed line range with new content. ALL THREE parameters are required: start_line, end_line, new_content. Call read_document first to find the correct line numbers; do not call replace_lines without them. To replace a single line, set start_line == end_line. new_content is inserted verbatim (include newlines if you want multiple lines).',
      parameters: {
        type: 'object',
        properties: {
          start_line: { type: 'integer', description: 'First line to replace (1-indexed, inclusive).' },
          end_line: { type: 'integer', description: 'Last line to replace (1-indexed, inclusive). Equal to start_line for a single-line edit.' },
          new_content: { type: 'string', description: 'Replacement text. Use "" to delete the range.' }
        },
        required: ['start_line', 'end_line', 'new_content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description:
        'Replace the first occurrence of an exact substring. Best when the substring is unique; otherwise prefer replace_lines or patch_document.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          replace: { type: 'string' }
        },
        required: ['search', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'patch_document',
      description:
        'Apply several search/replace edits atomically. Each edit is matched against the document state captured before the patch starts, then applied in document order. Fails as a whole if any edit cannot be matched (or matches more than once when unique=true).',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'Edits to apply in order.',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string' },
                replace: { type: 'string' },
                unique: {
                  type: 'boolean',
                  description: 'When true (default), the edit fails if "search" matches more than once.'
                }
              },
              required: ['search', 'replace']
            }
          }
        },
        required: ['edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_cursor',
      description: 'Insert text at the current cursor position in the editor.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_selection',
      description: 'Replace the currently selected text in the editor.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  }
];

/** Tool names that the page (content-main) executes. */
export const PAGE_TOOL_NAMES = new Set([
  'replace_lines',
  'search_replace',
  'patch_document',
  'insert_at_cursor',
  'replace_selection'
]);

/** Convert a custom-tool record into an OpenAI-style tool spec. */
export function customToolToSpec(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `Custom tool: ${tool.name}`,
      parameters: tool.parameters || { type: 'object', properties: {} }
    }
  };
}

/** Convert an MCP tool record into an OpenAI-style tool spec, scoped by server name. */
export function mcpToolToSpec(serverId, serverName, tool) {
  const safeServer = String(serverName || serverId).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 24);
  const safeTool = String(tool.name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48);
  return {
    type: 'function',
    function: {
      name: `mcp__${safeServer}__${safeTool}`,
      description: tool.description ? `[MCP ${serverName}] ${tool.description}` : `[MCP ${serverName}] ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} }
    }
  };
}
