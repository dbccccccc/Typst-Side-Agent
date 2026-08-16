const MAX_PROJECT_TREE_ENTRIES = 128;
const MAX_PROJECT_TREE_PATH_CHARS = 240;
const MAX_PROJECT_TREE_SEGMENT_CHARS = 160;
const PROJECT_TREE_SOURCE = 'files_panel_dom';
const ENTRY_KINDS = new Set(['file', 'folder', 'unknown']);
const FOLDER_STATES = new Set(['expanded', 'collapsed']);

export function normalizeProjectTreePath(value) {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  path = path.replace(/\/{2,}/g, '/');
  if (!path || path.length > MAX_PROJECT_TREE_PATH_CHARS || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const segments = path.split('/').map(segment => segment.trim());
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > MAX_PROJECT_TREE_SEGMENT_CHARS || /[\0\r\n]/.test(segment))) return null;
  return segments.join('/');
}

export function normalizeProjectTree(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.source !== PROJECT_TREE_SOURCE || !Array.isArray(value.entries)) return null;
  const entries = [];
  const seen = new Set();
  for (const raw of value.entries.slice(0, MAX_PROJECT_TREE_ENTRIES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const path = normalizeProjectTreePath(raw.path);
    const kind = ENTRY_KINDS.has(raw.kind) ? raw.kind : null;
    if (!path || !kind || seen.has(path)) continue;
    if (kind === 'folder') {
      const state = FOLDER_STATES.has(raw.state) ? raw.state : null;
      if (!state) continue;
      entries.push({ path, kind, state });
    } else {
      entries.push({ path, kind });
    }
    seen.add(path);
  }
  if (!entries.length) return null;
  return {
    source: PROJECT_TREE_SOURCE,
    entries,
    truncated: value.truncated === true || value.entries.length > MAX_PROJECT_TREE_ENTRIES
  };
}

export function projectTreeFromContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  return normalizeProjectTree(
    context.workspace?.project_file_tree ?? context.workspace?.projectFileTree
  );
}

export const PROJECT_TREE_LIMITS = Object.freeze({
  maxEntries: MAX_PROJECT_TREE_ENTRIES,
  maxPathChars: MAX_PROJECT_TREE_PATH_CHARS,
  maxSegmentChars: MAX_PROJECT_TREE_SEGMENT_CHARS
});
