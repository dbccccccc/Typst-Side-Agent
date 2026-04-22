/**
 * Bundled Typst grammar/reference docs. Each topic maps to a markdown file in
 * docs/typst/. Files are loaded from the extension package on demand and
 * cached in-memory for the lifetime of the service worker.
 *
 * Source: https://typst.app/docs/ (condensed, topic-separated).
 */

export const DOC_TOPICS = [
  {
    id: 'syntax-basics',
    file: '01-syntax-basics.md',
    title: 'Syntax Basics',
    summary:
      'Three modes (markup / code / math), literals, comments, identifiers, paths, operators, special chars.'
  },
  {
    id: 'markup',
    file: '02-markup.md',
    title: 'Markup',
    summary:
      'Paragraphs, headings (=, ==, …), lists (-, +, /), emphasis (*bold*, _italic_), links, labels, raw blocks.'
  },
  {
    id: 'math',
    file: '03-math.md',
    title: 'Math',
    summary:
      'Inline $…$ vs block $ … $, attachments, fractions, matrices, accents, styles, alignment, symbols reference.'
  },
  {
    id: 'scripting',
    file: '04-scripting.md',
    title: 'Scripting',
    summary:
      '#let, #if/#else, #for, #while, functions, closures, blocks, modules, #import, argument sinks.'
  },
  {
    id: 'types',
    file: '05-types.md',
    title: 'Types',
    summary:
      'Primitive types, content, array / dict / string methods, calc module, conversions.'
  },
  {
    id: 'styling',
    file: '06-styling.md',
    title: 'Styling',
    summary:
      'Set rules (#set …), show rules (#show …: it => …), selectors, where / and chains.'
  },
  {
    id: 'context',
    file: '07-context-introspection.md',
    title: 'Context & Introspection',
    summary:
      'context {…} blocks, counters, states, here(), query(), locate(), reactivity rules.'
  },
  {
    id: 'layout',
    file: '08-layout.md',
    title: 'Layout',
    summary:
      'Page setup, alignment, spacing (h, v), grids, stacks, columns, pagebreaks, place / float.'
  },
  {
    id: 'visualize',
    file: '09-visualize.md',
    title: 'Visualize',
    summary:
      'image(), shapes (rect, circle, …), colors, gradients, strokes, path / curve.'
  },
  {
    id: 'model',
    file: '10-model-elements.md',
    title: 'Model / Elements',
    summary:
      'Document metadata, figure + caption, table / tablex, outline, bibliography, refs.'
  },
  {
    id: 'data-loading',
    file: '11-data-loading.md',
    title: 'Data Loading',
    summary:
      'read(), json(), csv(), xml(), yaml(), toml(), cbor().'
  },
  {
    id: 'cheat-sheet',
    file: '12-cheat-sheet.md',
    title: 'Cheat Sheet',
    summary:
      'One-page quick reference for common patterns, set / show rules, math, errors.'
  }
];

const ALIASES = {
  basics: 'syntax-basics',
  syntax: 'syntax-basics',
  'syntax_basics': 'syntax-basics',
  element: 'model',
  elements: 'model',
  models: 'model',
  'model-elements': 'model',
  ctx: 'context',
  introspection: 'context',
  'context-introspection': 'context',
  visual: 'visualize',
  visualise: 'visualize',
  visualization: 'visualize',
  data: 'data-loading',
  'data_loading': 'data-loading',
  cheat: 'cheat-sheet',
  cheatsheet: 'cheat-sheet',
  'cheat_sheet': 'cheat-sheet',
  'show-rules': 'styling',
  'set-rules': 'styling',
  style: 'styling',
  styles: 'styling'
};

/**
 * Resolve a user-supplied topic string to a canonical id, or null if unknown.
 * Accepts: canonical id ("markup"), numeric index ("1".."12"), zero-padded
 * index ("01".."12"), file stem ("01-syntax-basics"), or an alias.
 */
export function resolveTopicId(input) {
  if (input == null) return null;
  const raw = String(input).trim().toLowerCase().replace(/\.md$/, '');
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= DOC_TOPICS.length) return DOC_TOPICS[n - 1].id;
  }

  const fileMatch = raw.match(/^(\d{1,2})-(.+)$/);
  if (fileMatch) {
    const n = parseInt(fileMatch[1], 10);
    if (n >= 1 && n <= DOC_TOPICS.length) return DOC_TOPICS[n - 1].id;
  }

  if (DOC_TOPICS.some(t => t.id === raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(ALIASES, raw)) return ALIASES[raw];
  return null;
}

/** Topic index for the model — id, title, and a one-line summary each. */
export function listDocTopics() {
  return DOC_TOPICS.map(({ id, title, summary }) => ({ id, title, summary }));
}

const DOC_CACHE = new Map();

/** Load a topic's markdown from the bundled docs folder. */
export async function readDocTopic(topicInput) {
  const id = resolveTopicId(topicInput);
  if (!id) {
    return {
      ok: false,
      error: `Unknown Typst docs topic: "${topicInput}". Call read_typst_docs with no topic to list available topics.`,
      available: listDocTopics()
    };
  }
  const topic = DOC_TOPICS.find(t => t.id === id);
  if (DOC_CACHE.has(id)) {
    return { ok: true, topic: id, title: topic.title, content: DOC_CACHE.get(id) };
  }
  try {
    const url = chrome.runtime.getURL(`docs/typst/${topic.file}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      return { ok: false, error: `Failed to load ${topic.file}: HTTP ${resp.status}` };
    }
    const content = await resp.text();
    DOC_CACHE.set(id, content);
    return { ok: true, topic: id, title: topic.title, content };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
