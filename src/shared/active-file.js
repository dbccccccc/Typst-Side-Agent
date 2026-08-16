const MAX_PATH_CHARS = 240;
const MAX_PROJECT_LABEL_CHARS = 160;
const MAX_SOURCE_CHARS = 64;
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
const PROJECT_FILE_BASENAME_RE = /\.[a-z0-9][a-z0-9+_-]{0,31}$/i;

export function normalizeProjectRelativePath(value) {
  if (typeof value !== 'string') return null;
  let path = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  path = path.replace(/\/{2,}/g, '/');
  if (!path || path.length > MAX_PATH_CHARS || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const segments = path.split('/').map(segment => segment.trim());
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\0\r\n]/.test(segment))) return null;
  if (!PROJECT_FILE_BASENAME_RE.test(segments.at(-1) || '')) return null;
  return segments.join('/');
}

export function normalizeActiveEditorFile(value) {
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

export function activeEditorFileFromContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  return normalizeActiveEditorFile(
    context.activeFile ?? context.active_file ??
    context.activeEditorFile ?? context.active_editor_file ??
    context.workspace?.active_editor_file ?? context.workspace?.activeEditorFile
  );
}

export function sameActiveEditorFile(left, right) {
  const a = normalizeActiveEditorFile(left);
  const b = normalizeActiveEditorFile(right);
  return !!a && !!b && a.relativePath === b.relativePath;
}

export function activeEditorFileLabel(value, fallback = 'Current Typst document') {
  const active = normalizeActiveEditorFile(value) || activeEditorFileFromContext(value);
  return active?.relativePath || fallback;
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}
