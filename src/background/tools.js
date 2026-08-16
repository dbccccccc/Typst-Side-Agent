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
      name: 'read_file_structure',
      description:
        'Read the names and visible hierarchy currently rendered in the Typst Files sidebar. If the Files sidebar is not open, this call pauses and asks the user to open it, then rechecks the page. This reads names only, never file contents. Contents of collapsed folders are unavailable; ask the user to expand folders and call this tool again when their children are needed.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_project_file',
      description:
        'Ask the user to open one exact project-relative file in the originating Typst Files sidebar. The call pauses until that exact breadcrumb path is open and Typst exposes its text editor to the agent. On success, subsequent read_document and editor tools in this response target that file. Use this before reading or editing a file other than the one currently open, and wait for its result before issuing those document tools or requesting another file. This tool cannot expose binary or preview-only assets as editable text.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Exact project-relative path obtained from read_file_structure, for example "chapters/intro.typ" or "references/ref.bib".'
          }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description:
        'Fetch source from the Typst project file that was open when the user sent the latest message. Numbered lines look like "  N|line text"; the "N|" prefix is metadata, not source. By default returns the start of the document up to max_chars. Pass start_line / end_line (1-indexed, inclusive) to read a specific range — the response includes approx_line_count so you can page further. If the user opens another file, this call pauses until they return to the message file.',
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
        `Read fresh diagnostics from the originating Typst tab after an initial ${LIMITS.DIAGNOSTICS_SETTLE_DELAY_MS} ms compiler-settling delay and bounded stability checks. Merges project-level and line-level Improve-sidebar messages with CodeMirror lint positions; project-level rows have line: null. Kinds are "typst" (visible compiler detail), "typst-summary" (reported compiler item whose detail is unavailable), "typst-status" (status could not be verified), and "spelling". Response includes disjoint error_count / warning_count / spelling_count / status_count. Call with an empty object; timing is not model-configurable.`,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_typst_docs',
      description:
        'Look up bundled Typst 0.15.1 language / grammar reference docs. Call this whenever you are unsure about Typst syntax, a function signature, the right set/show rule, math symbol, or idiomatic pattern. Call with NO "topic" argument to get the target version and topic index (id + one-line summary of each); call with "topic" (e.g. "markup", "math", "scripting", or "1".."12") to read that topic as markdown.',
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
        'Replace an inclusive 1-indexed line range with new content. ALL THREE parameters are required: start_line, end_line, new_content. Call read_document first to find the correct line numbers; do not call replace_lines without them. To replace a single line, set start_line == end_line. new_content is inserted verbatim (include newlines if you want multiple lines); an empty string deletes the physical line range including one boundary newline.',
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

/** Trusted, source-owned effect metadata. Model output can never override it. */
export const BUILTIN_TOOL_METADATA = Object.freeze({
  read_file_structure: Object.freeze({ effect: 'read', approval: 'automatic', destination: 'visible Typst Files sidebar' }),
  open_project_file: Object.freeze({ effect: 'read', approval: 'automatic', destination: 'originating Typst Files sidebar' }),
  read_document: Object.freeze({ effect: 'read', approval: 'automatic', destination: 'active Typst editor file' }),
  read_diagnostics: Object.freeze({ effect: 'read', approval: 'automatic', destination: 'typst.app diagnostics' }),
  read_typst_docs: Object.freeze({ effect: 'read', approval: 'automatic', destination: 'bundled Typst reference' }),
  replace_lines: Object.freeze({ effect: 'editor-write', approval: 'once', destination: 'originating Typst editor' }),
  search_replace: Object.freeze({ effect: 'editor-write', approval: 'once', destination: 'originating Typst editor' }),
  patch_document: Object.freeze({ effect: 'editor-write', approval: 'once', destination: 'originating Typst editor' }),
  insert_at_cursor: Object.freeze({ effect: 'editor-write', approval: 'once', destination: 'originating Typst editor' }),
  replace_selection: Object.freeze({ effect: 'editor-write', approval: 'once', destination: 'originating Typst editor' })
});
