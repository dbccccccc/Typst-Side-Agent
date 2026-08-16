/**
 * typst.app workspace / file UI heuristics (MAIN world).
 *
 * Detects when the center column shows an asset detail (Path, Format, …) versus
 * the Typst canvas, and gathers bounded workspace hints. Callers can omit the
 * exact visible tree; normal model messages discard it and tools consume it
 * only through the identity workspace response.
 *
 * Exposes globalThis.__typstAgentWorkspaceExtract.
 */
(function (root) {
  'use strict';

  const FILE_EXT_RE = /\.(typ(?:st)?|png|jpe?g|gif|webp|svg|pdf|ttf|otf|woff2?|eot|bib|csv|tsv|md|txt|json|toml|xml|yml|yaml|wasm)$/i;
  const KNOWN_FOLDER_NAMES = /^(fonts|images|src|assets|lib|figures|data|sections|chapters)$/i;
  const PROJECT_FILE_RE = /\.[a-z0-9][a-z0-9+_-]{0,31}$/i;
  const MAX_PROJECT_TREE_ENTRIES = 128;
  const MAX_PROJECT_TREE_DEPTH = 12;

  function cleanInlineText(value, max = 240) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
  }

  function normalizeProjectRelativePath(value) {
    if (typeof value !== 'string') return null;
    let path = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
    path = path.replace(/\/{2,}/g, '/');
    if (!path || path.length > 240 || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
    const segments = path.split('/').map(segment => segment.trim());
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\0\r\n]/.test(segment))) return null;
    if (!PROJECT_FILE_RE.test(segments[segments.length - 1] || '')) return null;
    return segments.join('/');
  }

  function activeFileRecord(relativePath, projectLabel, source, confidence) {
    const path = normalizeProjectRelativePath(relativePath);
    if (!path) return null;
    return {
      projectLabel: cleanInlineText(projectLabel, 160) || null,
      relativePath: path,
      basename: path.split('/').pop(),
      source,
      confidence
    };
  }

  function elementPathAttribute(element) {
    for (let node = element, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      for (const attr of ['data-path', 'data-file', 'data-relpath', 'title']) {
        const path = normalizeProjectRelativePath(node.getAttribute?.(attr));
        if (path) return path;
      }
    }
    return null;
  }

  function safeRect(element) {
    try { return element?.getBoundingClientRect?.() || null; } catch { return null; }
  }

  function isInTopHeader(element, doc, allowContainer = false) {
    const rect = safeRect(element);
    if (!rect) return false;
    const win = doc.defaultView || window;
    const viewportWidth = win.innerWidth || 1600;
    const maxBottom = 112;
    if (rect.width < 2 || rect.height < 2 || rect.top < -12 || rect.top > maxBottom || rect.bottom > maxBottom + 20) return false;
    if (allowContainer && (rect.width > Math.min(1100, viewportWidth * 0.82) || rect.height > 100)) return false;
    return true;
  }

  function breadcrumbLeafTexts(container) {
    const nodes = [container];
    try {
      nodes.push(...container.querySelectorAll('a, button, span, strong, b, [role="link"], [role="button"], [aria-current]'));
    } catch { /* an unusual page node is not queryable */ }
    const out = [];
    for (const node of nodes) {
      const text = cleanInlineText(node?.textContent, 180);
      if (!text || /^[>›❯»/|]+$/.test(text) || /[\r\n]/.test(text)) continue;
      const children = Array.from(node?.children || []);
      if (children.some(child => cleanInlineText(child.textContent, 180) === text)) continue;
      const pieces = text.split(/\s*[>›❯»]\s*/).map(part => cleanInlineText(part, 160)).filter(Boolean);
      if (node === container && pieces.length > 1) return pieces.slice(0, 16);
      if (node === container && children.length > 0) continue;
      for (const piece of pieces) {
        if (out[out.length - 1] !== piece) out.push(piece);
      }
    }
    return out.slice(0, 16);
  }

  function activeFileFromBreadcrumbSegments(segments, source = 'header_breadcrumb', confidence = 'high') {
    const clean = (segments || []).map(segment => cleanInlineText(segment, 160)).filter(Boolean);
    let fileIndex = -1;
    for (let index = clean.length - 1; index >= 0; index--) {
      if (PROJECT_FILE_RE.test(clean[index])) { fileIndex = index; break; }
    }
    if (fileIndex < 0) return null;
    const throughFile = clean.slice(0, fileIndex + 1);
    if (throughFile.length === 1) return activeFileRecord(throughFile[0], null, source, 'medium');
    if (throughFile.length === 2) {
      return activeFileRecord(throughFile[1], throughFile[0], source, confidence);
    }
    // typst.app renders account/workspace › project › folders… › file.
    // The account is not part of a project-relative file path.
    return activeFileRecord(throughFile.slice(2).join('/'), throughFile[1], source, confidence);
  }

  function semanticHeaderBreadcrumbActiveFile(doc) {
    let containers = [];
    try {
      containers = doc.querySelectorAll(
        'header [role="heading"][aria-level="1"], [role="banner"] [role="heading"][aria-level="1"], header h1, [role="banner"] h1'
      );
    } catch { return null; }
    for (const container of containers) {
      if (!isInTopHeader(container, doc, true)) continue;
      const record = activeFileFromBreadcrumbSegments(breadcrumbLeafTexts(container));
      if (record) return record;
    }
    return null;
  }

  function headerBreadcrumbActiveFile(doc) {
    const semantic = semanticHeaderBreadcrumbActiveFile(doc);
    if (semantic) return semantic;
    const selector = 'a, button, span, strong, b, [role="link"], [role="button"], [aria-current], [data-path], [data-file], [data-relpath]';
    const candidates = [];
    doc.querySelectorAll(selector).forEach(element => {
      const text = cleanInlineText(element.textContent, 220);
      if (!text || !PROJECT_FILE_RE.test(text) || /[\r\n<>]/.test(text) || !isInTopHeader(element, doc)) return;
      const rect = safeRect(element);
      const win = doc.defaultView || window;
      const center = (rect.left + rect.right) / 2;
      candidates.push({ element, text, centerDistance: Math.abs(center - (win.innerWidth || 1600) / 2) });
    });
    candidates.sort((left, right) => left.centerDistance - right.centerDistance);

    let basenameFallback = null;
    for (const candidate of candidates.slice(0, 12)) {
      const declaredPath = elementPathAttribute(candidate.element);
      if (declaredPath) return activeFileRecord(declaredPath, null, 'header_declared_path', 'high');
      for (let node = candidate.element, depth = 0; node && node !== doc.body && depth < 9; node = node.parentElement, depth++) {
        if (!isInTopHeader(node, doc, true)) continue;
        const record = activeFileFromBreadcrumbSegments(breadcrumbLeafTexts(node));
        if (record?.relativePath.includes('/')) return record;
        if (record && !basenameFallback) basenameFallback = record;
      }
      if (!basenameFallback) basenameFallback = activeFileRecord(candidate.text, null, 'header_filename', 'medium');
    }
    return basenameFallback;
  }

  function selectedTreeActiveFile(doc, filesPanelRoot) {
    const root = filesPanelRoot || doc;
    let selected = [];
    try {
      selected = root.querySelectorAll(
        '[aria-selected="true"], [aria-current="page"], [aria-current="true"], button[class*="_active_"], [role="treeitem"][class*="_active_"]'
      );
    }
    catch { return null; }
    for (const element of selected) {
      const declaredPath = elementPathAttribute(element);
      if (declaredPath) return activeFileRecord(declaredPath, null, 'selected_tree_path', 'high');
      const text = cleanInlineText(element.textContent, 220);
      if (text && PROJECT_FILE_RE.test(text) && !/[\r\n<>]/.test(text)) {
        return activeFileRecord(text, null, 'selected_tree_filename', 'medium');
      }
    }
    return null;
  }

  function bodyBreadcrumbActiveFile(bodyText) {
    const compact = String(bodyText || '').replace(/[›❯»]/g, '>').replace(/\s+/g, ' ');
    const pattern = /([^>]{1,160})>\s*((?:[^>]{1,160}>\s*)*?[^>]{1,160}\.[a-z0-9][a-z0-9+_-]{0,31})(?=\s|$)/ig;
    for (const match of compact.matchAll(pattern)) {
      const first = cleanInlineText(match[1], 160).split(/\s+/).filter(Boolean).pop();
      const tail = match[2].split('>').map(part => cleanInlineText(part, 160)).filter(Boolean);
      const record = activeFileFromBreadcrumbSegments([first, ...tail], 'body_breadcrumb', 'medium');
      if (record) return record;
    }
    return null;
  }

  function documentTitleActiveFile(doc) {
    const title = cleanInlineText(doc.title, 400);
    const match = title.match(/^(.+?)\s+[–—-]\s+(.+?)\s+[–—-]\s+Typst$/i);
    if (!match) return null;
    return activeFileRecord(match[2], match[1], 'document_title', 'medium');
  }

  function resolveUniqueDeclaredPath(activeFile, declaredPaths) {
    if (!activeFile || activeFile.relativePath.includes('/')) return activeFile;
    const suffix = `/${activeFile.basename}`;
    const matches = (declaredPaths || []).map(normalizeProjectRelativePath).filter(Boolean)
      .filter(path => path === activeFile.basename || path.endsWith(suffix));
    if (matches.length !== 1) return activeFile;
    return activeFileRecord(matches[0], activeFile.projectLabel, 'unique_declared_path', 'high');
  }

  function pickField(bodyText, label) {
    const re = new RegExp(label + ':\\s*\\n?\\s*([^\\n\\r]+)', 'i');
    const m = bodyText.match(re);
    return m ? m[1].trim() : null;
  }

  function pickPathFromDom(doc) {
    const candidates = doc.querySelectorAll('dt, th, td, span, label, div, p, button');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const t = (el.textContent || '').trim();
      if (!/^path\s*:?$/i.test(t) && t !== 'Path') continue;
      const next = el.nextElementSibling;
      if (next) {
        const v = (next.textContent || '').trim();
        if (v.length > 2 && v.length < 400 && /[./\\]/.test(v) && !/^path$/i.test(v)) return v;
      }
      const parent = el.parentElement;
      if (parent) {
        const full = (parent.textContent || '').replace(/\s+/g, ' ');
        const m = full.match(/Path\s*:?\s*([^\s].*?)(?:\s+(?:Format|Resolution|Size)\s*:)|$/i);
        if (m && m[1]) {
          const v = m[1].trim();
          if (v.length > 2 && v.length < 400) return v;
        }
      }
    }
    return null;
  }

  function inferPathFromBreadcrumb(bodyText, filenameHint) {
    const norm = bodyText.replace(/\s+/g, ' ');
    const m = norm.match(/>\s*images\s*>\s*([^\s>]+)/i);
    if (m && m[1]) {
      const file = m[1].trim();
      if (!filenameHint || file.toLowerCase() === filenameHint.toLowerCase()) {
        return 'images/' + file;
      }
    }
    const mFont = norm.match(/>\s*fonts\s*>\s*([^<\n\r]+?\.(?:ttf|otf|woff2?))\b/i);
    if (mFont && mFont[1]) {
      const tail = mFont[1].trim();
      if (tail) return 'fonts/' + tail.replace(/^\/+/, '');
    }
    const m2 = norm.match(
      />\s*([\w.-]+(?:\/[\w.-]+)*\/[^\s>]+\.(?:png|jpe?g|gif|webp|svg|pdf|ttf|otf|woff2?))\b/i
    );
    if (m2 && m2[1]) return m2[1].trim();
    return null;
  }

  function largestCanvasPixelArea(doc) {
    let max = 0;
    doc.querySelectorAll('canvas').forEach(c => {
      const w = c.width || 0;
      const h = c.height || 0;
      max = Math.max(max, w * h);
    });
    return max;
  }

  function ariaSelectedTexts(doc) {
    const out = [];
    doc.querySelectorAll('[aria-selected="true"]').forEach(el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t.length > 0 && t.length < 220 && !out.includes(t)) out.push(t);
    });
    return out.slice(0, 10);
  }

  function focusAncestorFilenameHint(doc) {
    let n = doc.activeElement;
    for (let d = 0; d < 10 && n && n !== doc.body; d++) {
      const t = (n.textContent || '').trim();
      if (t && t.length < 200 && /\.[a-z0-9]{2,8}$/i.test(t.split(/\s+/).pop() || '')) {
        const last = t.split(/\s+/).filter(Boolean).pop();
        if (last && last.includes('.')) return last;
      }
      n = n.parentElement;
    }
    return null;
  }

  function findFilesPanelRoot(doc) {
    try {
      for (const region of doc.querySelectorAll('[role="region"]')) {
        const heading = region.querySelector?.('[role="heading"], h1, h2, h3, h4, strong');
        if (/^files$/i.test(cleanInlineText(heading?.textContent, 24)) && isVisiblePanel(region, doc)) return region;
      }
    } catch { /* fall through to geometry/text heuristics */ }

    const win = doc.defaultView || window;
    const vw = win.innerWidth || 1600;
    const heads = doc.querySelectorAll('span, div, h1, h2, h3, h4, button, p, label');
    for (let i = 0; i < heads.length; i++) {
      const el = heads[i];
      const raw = (el.textContent || '').trim();
      if (raw.length > 24) continue;
      if (raw !== 'Files' && !/^files$/i.test(raw)) continue;
      let n = el.parentElement;
      for (let d = 0; d < 14 && n && n !== doc.body; n = n.parentElement, d++) {
        const r = n.getBoundingClientRect?.();
        const noLayout = !r || (r.width <= 1 && r.height <= 1);
        const geo = r && r.width >= 60 && r.width <= vw * 0.48 && r.height >= 40 && r.left <= vw * 0.34;
        const txt = (n.innerText || '').slice(0, 12000);
        const hasFile = FILE_EXT_RE.test(txt);
        if (!hasFile || txt.length > 20000) continue;
        if (geo && isVisiblePanel(n, doc)) return n;
        if (noLayout && d < 8 && isVisiblePanel(n, doc)) return n;
      }
    }
    return null;
  }

  function isVisiblePanel(element, doc) {
    if (!element) return false;
    for (let node = element, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      try {
        const style = (doc.defaultView || window).getComputedStyle?.(node);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
      } catch { /* geometry remains the final visibility signal */ }
    }
    if (typeof element.getBoundingClientRect !== 'function') return true;
    const rect = safeRect(element);
    if (!rect || rect.width <= 1 || rect.height <= 1) return false;
    const win = doc.defaultView || window;
    const width = win.innerWidth || 1600;
    const height = win.innerHeight || 900;
    return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
  }

  function directChildByTag(element, tagName) {
    const upper = String(tagName || '').toUpperCase();
    return Array.from(element?.children || []).find(child => child?.tagName === upper) || null;
  }

  function directTreeRows(container) {
    return Array.from(container?.children || []).filter(child =>
      child?.tagName === 'LI' || child?.getAttribute?.('role') === 'treeitem'
    );
  }

  function directNestedTree(row) {
    return Array.from(row?.children || []).find(child =>
      child?.tagName === 'UL' || ['group', 'tree'].includes(child?.getAttribute?.('role'))
    ) || null;
  }

  function primaryTreeButton(row) {
    return directChildByTag(row, 'button') || (row?.getAttribute?.('role') === 'treeitem' ? row : null);
  }

  function looksLikeCollapsedFolderButton(button) {
    let svg;
    try { svg = button?.querySelector?.('svg'); } catch { return false; }
    if (!svg) return false;
    let paths;
    try {
      if (svg.querySelector?.('rect, circle, ellipse, line, polyline, polygon')) return false;
      paths = Array.from(svg.querySelectorAll?.('path') || []);
    } catch { return false; }
    if (paths.length !== 1) return false;
    const drawing = paths[0].getAttribute?.('d') || '';
    const moves = drawing.match(/[Mm]/g) || [];
    // The current Typst closed-folder glyph is a single closed curved outline.
    // Fail to `unknown` if the icon changes instead of guessing that an entry is a file.
    return moves.length === 1 && /[Cc]/.test(drawing) && /[Hh]/.test(drawing) &&
      /[Vv]/.test(drawing) && /[Zz]\s*$/.test(drawing);
  }

  function cleanTreeEntryName(value) {
    const name = cleanInlineText(value, 160);
    if (!name || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)) return null;
    return name;
  }

  function findProjectTreeRoot(filesPanelRoot) {
    if (!filesPanelRoot) return null;
    const candidates = [];
    if (filesPanelRoot.tagName === 'UL' || filesPanelRoot.getAttribute?.('role') === 'tree') candidates.push(filesPanelRoot);
    try { candidates.push(...filesPanelRoot.querySelectorAll('ul, [role="tree"]')); } catch { return null; }
    return candidates.find(candidate => directTreeRows(candidate).length > 0) || null;
  }

  function extractProjectFileTree(filesPanelRoot) {
    const rootList = findProjectTreeRoot(filesPanelRoot);
    if (!rootList) return null;
    const entries = [];
    let truncated = false;

    const scan = (list, parentPath, depth) => {
      if (depth > MAX_PROJECT_TREE_DEPTH) { truncated = true; return; }
      for (const row of directTreeRows(list)) {
        if (entries.length >= MAX_PROJECT_TREE_ENTRIES) { truncated = true; return; }
        const button = primaryTreeButton(row);
        const name = cleanTreeEntryName(button?.innerText || button?.textContent);
        if (!name) { truncated = true; continue; }
        const path = parentPath ? `${parentPath}/${name}` : name;
        if (path.length > 240) { truncated = true; continue; }
        const nested = directNestedTree(row);
        if (nested || looksLikeCollapsedFolderButton(button)) {
          entries.push({ path, kind: 'folder', state: nested ? 'expanded' : 'collapsed' });
          if (nested) scan(nested, path, depth + 1);
        } else if (PROJECT_FILE_RE.test(name)) {
          entries.push({ path, kind: 'file' });
        } else {
          entries.push({ path, kind: 'unknown' });
        }
      }
    };

    scan(rootList, '', 0);
    return entries.length ? { source: 'files_panel_dom', entries, truncated } : null;
  }

  function collectLeafFilenamesIn(root) {
    if (!root) return [];
    const found = [];
    root.querySelectorAll('*').forEach(el => {
      if (el.children.length !== 0) return;
      const t = (el.textContent || '').trim();
      if (t.length < 3 || t.length > 160) return;
      if (!FILE_EXT_RE.test(t)) return;
      if (/[\n\r\t]/.test(t)) return;
      found.push(t);
    });
    return [...new Set(found)];
  }

  const LEFT_STRIP_SKIP = /^(Path|Format|Resolution|Size|Last changed|Files|Add|New|Upload|Download|Typst|Tell the agent)/i;

  function leftStripFilenameHints(doc) {
    const win = doc.defaultView || window;
    const vw = win.innerWidth || 1600;
    const vh = win.innerHeight || 900;
    const maxRight = Math.min(440, vw * 0.36);
    const seen = new Set();
    const out = [];
    doc.querySelectorAll('button, a, [role="option"], [role="menuitem"], li, span, div').forEach(el => {
      if (el.children.length !== 0) return;
      let r;
      try { r = el.getBoundingClientRect(); } catch { return; }
      if (!r || r.width < 8 || r.height < 8) return;
      if (r.right > maxRight || r.left < -4) return;
      if (r.bottom < -40 || r.top > vh + 80) return;
      const t = (el.textContent || '').trim();
      if (t.length < 3 || t.length > 140) return;
      if (LEFT_STRIP_SKIP.test(t)) return;
      if (!FILE_EXT_RE.test(t)) return;
      if (seen.has(t)) return;
      seen.add(t);
      out.push(t);
    });
    return out;
  }

  function treeFilenameHints(doc) {
    const tree = doc.querySelector('[role="tree"], [role="treegrid"]');
    if (!tree) return [];
    const found = [];
    tree.querySelectorAll('[role="treeitem"], [role="row"], li, button, a').forEach(el => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t.length > 180) return;
      if (FILE_EXT_RE.test(t)) found.push(t);
    });
    return [...new Set(found)].slice(0, 32);
  }

  function collectKnownFolderHintsIn(root) {
    if (!root) return [];
    const set = new Set();
    root.querySelectorAll('*').forEach(el => {
      if (el.children.length !== 0) return;
      const t = (el.textContent || '').trim();
      if (KNOWN_FOLDER_NAMES.test(t)) set.add(t);
    });
    return [...set];
  }

  function mergeFolderHints(filesPanelRoot, doc) {
    const set = new Set();
    collectKnownFolderHintsIn(filesPanelRoot).forEach(t => set.add(t));
    const raw = (doc.body && doc.body.innerText) || '';
    raw.split(/[\s\n\r|>]+/).forEach(tok => {
      const t = tok.trim();
      if (KNOWN_FOLDER_NAMES.test(t)) set.add(t);
    });
    return [...set].slice(0, 16);
  }

  function fallbackFilenamesFromInnerText(doc) {
    const raw = (doc.body && doc.body.innerText) || '';
    const tokens = raw.split(/[\s\n\r|>]+/).map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const tok of tokens) {
      if (tok.length < 5 || tok.length > 200) continue;
      if (!FILE_EXT_RE.test(tok)) continue;
      if (/:/.test(tok)) continue;
      if (/^(Format|Resolution|JPEG|PNG|GIF|TrueType|OpenType)$/i.test(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
    return out.slice(0, 48);
  }

  function mergeFileTreeFilenameHints(doc, filesPanelRoot) {
    const set = new Set();
    treeFilenameHints(doc).forEach(t => set.add(t));
    collectLeafFilenamesIn(filesPanelRoot).forEach(t => set.add(t));
    leftStripFilenameHints(doc).forEach(t => set.add(t));
    if (set.size === 0) fallbackFilenamesFromInnerText(doc).forEach(t => set.add(t));
    return [...set].slice(0, 64);
  }

  function collectDeclaredPathsIn(panel, doc) {
    const seen = new Set();
    const scan = (root) => {
      if (!root) return;
      root.querySelectorAll('[data-path], [data-file], [data-relpath], [title]').forEach(el => {
        for (const attr of ['data-path', 'data-file', 'data-relpath', 'title']) {
          const v = el.getAttribute && el.getAttribute(attr);
          if (!v || typeof v !== 'string') continue;
          const t = v.trim().replace(/\\/g, '/');
          if (t.length < 4 || t.length > 400) continue;
          if (/^https?:/i.test(t)) continue;
          if (!FILE_EXT_RE.test(t)) continue;
          if (attr === 'title' && !/[./]/.test(t)) continue;
          seen.add(t);
        }
      });
    };
    scan(panel);
    if (seen.size < 3) scan(doc.body);
    return [...seen].slice(0, 40);
  }

  function directoryPrefixFromDetailPath(detailPath) {
    if (!detailPath || typeof detailPath !== 'string') return null;
    const n = detailPath.replace(/\\/g, '/');
    const i = n.lastIndexOf('/');
    if (i <= 0) return null;
    return n.slice(0, i);
  }

  function guessRelativePaths(filenames, folderHints, detailPath) {
    const folders = new Set((folderHints || []).map(String));
    const pref = directoryPrefixFromDetailPath(detailPath);
    const imgExt = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
    const fontExt = /\.(ttf|otf|woff2?|eot)$/i;
    const detailIsImg = detailPath && imgExt.test(String(detailPath));
    const detailIsFont = detailPath && fontExt.test(String(detailPath));
    const out = [];
    const seen = new Set();
    for (const raw of filenames || []) {
      const f = String(raw).trim();
      if (!f) continue;
      if (f.includes('/') || f.includes('\\')) {
        const n = f.replace(/\\/g, '/');
        if (!seen.has(n)) { seen.add(n); out.push(n); }
        continue;
      }
      let g = f;
      if (pref && detailIsImg && imgExt.test(f)) g = `${pref}/${f}`;
      else if (pref && detailIsFont && fontExt.test(f)) g = `${pref}/${f}`;
      else if (f.toLowerCase().endsWith('.typ')) g = f;
      else if (folders.has('images') && imgExt.test(f)) g = `images/${f}`;
      else if (folders.has('fonts') && fontExt.test(f)) g = `fonts/${f}`;
      if (!seen.has(g)) { seen.add(g); out.push(g); }
    }
    return out.slice(0, 64);
  }

  function buildFileTreePathsGuess(declared, filenames, folderHints, detailPath) {
    const set = new Set(declared || []);
    guessRelativePaths(filenames, folderHints, detailPath).forEach(p => set.add(p));
    return [...set].slice(0, 64);
  }

  function looksLikeRasterAssetPanel(detailFormat, detailResolution, detailSize) {
    if (!detailFormat || !detailResolution) return false;
    if (!/^(PNG|JPEG|JPG|GIF|WebP|SVG|BMP|TIFF?)/i.test(detailFormat.trim())) return false;
    if (!/\d+\s*[x×]\s*\d+/.test(detailResolution)) return false;
    if (detailSize && /\d+(\.\d+)?\s*(kB|KB|MB|MiB|KiB|bytes?)/i.test(detailSize)) return true;
    return true;
  }

  function looksLikeFontAssetPanel(detailFormat, detailSize) {
    if (!detailFormat) return false;
    const f = detailFormat.trim();
    if (!/^(TrueType|OpenType|OTF|TTF|WOFF2?|WOFF|Variable\s+Font)/i.test(f)) return false;
    if (detailSize && /\d+(\.\d+)?\s*(kB|KB|MB|MiB|KiB|bytes?)/i.test(detailSize)) return true;
    return !!detailSize;
  }

  function classifyPreviewKind(detailPath, canvasArea, detailFormat, detailResolution, detailSize) {
    if (detailPath) {
      const lower = detailPath.toLowerCase();
      if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/i.test(lower)) return 'binary_image_asset';
      if (/\.(ttf|otf|woff2?|eot)$/i.test(lower)) return 'font_binary_asset';
      if (/\.(pdf|zip|tar|gz|wasm)$/i.test(lower)) return 'binary_other_asset';
      if (/\.typ(st)?$/i.test(lower)) return 'typst_source_file';
      return 'file_asset_detail';
    }
    if (looksLikeRasterAssetPanel(detailFormat, detailResolution, detailSize)) return 'binary_image_asset';
    if (looksLikeFontAssetPanel(detailFormat, detailSize)) return 'font_binary_asset';
    if (canvasArea > 120000) return 'typst_document_render';
    return 'unknown_layout';
  }

  function extract(doc, options = {}) {
    const bodyText = doc.body?.innerText || '';
    const pathFromBody = pickField(bodyText, 'Path');
    let detail_path = pathFromBody || pickPathFromDom(doc);
    const detail_format = pickField(bodyText, 'Format');
    const detail_resolution = pickField(bodyText, 'Resolution');
    const detail_size = pickField(bodyText, 'Size');
    const detail_last_changed = pickField(bodyText, 'Last changed');

    const selected_ui_hints = ariaSelectedTexts(doc);
    const focused_element_file_hint = focusAncestorFilenameHint(doc);
    const filesPanelRoot = findFilesPanelRoot(doc);
    const project_file_tree = options?.includeProjectTree !== false
      ? extractProjectFileTree(filesPanelRoot)
      : null;
    const file_tree_filename_hints = mergeFileTreeFilenameHints(doc, filesPanelRoot);
    const file_tree_folder_hints = mergeFolderHints(filesPanelRoot, doc);
    const declaredPaths = collectDeclaredPathsIn(filesPanelRoot, doc);
    let active_editor_file = headerBreadcrumbActiveFile(doc) || documentTitleActiveFile(doc) ||
      selectedTreeActiveFile(doc, filesPanelRoot) || bodyBreadcrumbActiveFile(bodyText) ||
      (focused_element_file_hint && PROJECT_FILE_RE.test(focused_element_file_hint)
        ? activeFileRecord(focused_element_file_hint, null, 'focused_element', 'low')
        : null);
    active_editor_file = resolveUniqueDeclaredPath(active_editor_file, declaredPaths);

    let path_source = null;
    if (pathFromBody) path_source = 'body_text';
    else if (detail_path) path_source = 'dom';
    if (!detail_path) {
      const fromCrumb = inferPathFromBreadcrumb(bodyText, focused_element_file_hint);
      if (fromCrumb) { detail_path = fromCrumb; path_source = 'breadcrumb'; }
      else if (focused_element_file_hint && /\.(png|jpe?g|gif|webp|svg|pdf|ttf|otf|woff2?)$/i.test(focused_element_file_hint)) {
        detail_path = focused_element_file_hint;
        path_source = 'focused_filename';
      }
    }

    const canvas_max_pixel_area = largestCanvasPixelArea(doc);
    const preview_kind = classifyPreviewKind(detail_path, canvas_max_pixel_area, detail_format, detail_resolution, detail_size);

    let notes;
    if (detail_format && detail_resolution && preview_kind === 'binary_image_asset') {
      notes = path_source && path_source !== 'body_text'
        ? 'Asset metadata panel detected. Path was inferred from a breadcrumb or focused name; verify against the project tree.'
        : 'Asset metadata panel detected. The user may be inspecting this file while a Typst canvas still exists elsewhere.';
    } else if (preview_kind === 'font_binary_asset') {
      notes = detail_path
        ? 'Font binary asset (Path / Format). A Typst canvas may still exist in split view.'
        : 'Font metadata panel detected without a parsed Path; preview_kind is not typst_document_render even if a large canvas is visible.';
    } else if (detail_path) {
      notes = 'A file path or asset context is available. The main Typst canvas may still be present in split view.';
    } else if (canvas_max_pixel_area > 120000) {
      notes = 'Large canvas detected — likely the main Typst page render.';
    } else {
      notes = 'Could not match Path:/Format: labels; UI may differ. file_tree_filename_hints may still list project files.';
    }

    const file_tree_paths_guess = buildFileTreePathsGuess(
      active_editor_file ? [...declaredPaths, active_editor_file.relativePath] : declaredPaths,
      file_tree_filename_hints,
      file_tree_folder_hints,
      detail_path
    );
    if (file_tree_paths_guess.some(p => /[./]/.test(p) && p.includes('/'))) {
      notes += ' file_tree_paths_guess merges DOM path attributes with directory heuristics from detail_path / common folders — not a guaranteed project tree.';
    }
    if (active_editor_file) notes += ` Active editor file: ${active_editor_file.relativePath} (${active_editor_file.source}, ${active_editor_file.confidence} confidence).`;

    const result = {
      preview_kind,
      detail_path,
      detail_path_source: path_source,
      detail_format,
      detail_resolution,
      detail_size,
      detail_last_changed,
      canvas_max_pixel_area,
      selected_ui_hints,
      active_editor_file,
      files_panel_open: !!filesPanelRoot,
      focused_element_file_hint,
      file_tree_filename_hints,
      file_tree_folder_hints,
      file_tree_paths_guess,
      notes
    };
    if (project_file_tree) result.project_file_tree = project_file_tree;
    return result;
  }

  root.__typstAgentFindFilesPanelRoot = findFilesPanelRoot;
  root.__typstAgentWorkspaceExtract = extract;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
