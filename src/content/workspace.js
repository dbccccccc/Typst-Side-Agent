/**
 * typst.app workspace / file UI heuristics (MAIN world).
 *
 * Detects when the center column shows an asset detail (Path, Format, …) versus
 * the Typst canvas, and gathers file-tree hints so the agent knows which file
 * the user is focused on.
 *
 * Exposes globalThis.__typstAgentWorkspaceExtract.
 */
(function (root) {
  'use strict';

  const FILE_EXT_RE = /\.(typ|png|jpe?g|gif|webp|svg|pdf|ttf|otf|woff2?|eot|bib|csv|md|txt|json|yml|yaml|wasm)$/i;
  const KNOWN_FOLDER_NAMES = /^(fonts|images|src|assets|lib|figures|data|sections|chapters)$/i;

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
      />\s*([\w.-]+(?:\/[\w.-]+)*\/[^\s>]+\.(?:png|jpe?g|gif|webp|svg|pdf|ttf|otf|woff2?|typ))\b/i
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
        if (geo) return n;
        if (noLayout && d < 8) return n;
      }
    }
    return null;
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

  function extract(doc) {
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
    const file_tree_filename_hints = mergeFileTreeFilenameHints(doc, filesPanelRoot);
    const file_tree_folder_hints = mergeFolderHints(filesPanelRoot, doc);
    const declaredPaths = collectDeclaredPathsIn(filesPanelRoot, doc);

    let path_source = null;
    if (pathFromBody) path_source = 'body_text';
    else if (detail_path) path_source = 'dom';
    if (!detail_path) {
      const fromCrumb = inferPathFromBreadcrumb(bodyText, focused_element_file_hint);
      if (fromCrumb) { detail_path = fromCrumb; path_source = 'breadcrumb'; }
      else if (focused_element_file_hint && /\.(png|jpe?g|gif|webp|svg|pdf|ttf|otf|woff2?|typ(st)?)$/i.test(focused_element_file_hint)) {
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
      declaredPaths,
      file_tree_filename_hints,
      file_tree_folder_hints,
      detail_path
    );
    if (file_tree_paths_guess.some(p => /[./]/.test(p) && p.includes('/'))) {
      notes += ' file_tree_paths_guess merges DOM path attributes with directory heuristics from detail_path / common folders — not a guaranteed project tree.';
    }

    return {
      preview_kind,
      detail_path,
      detail_path_source: path_source,
      detail_format,
      detail_resolution,
      detail_size,
      detail_last_changed,
      canvas_max_pixel_area,
      selected_ui_hints,
      focused_element_file_hint,
      file_tree_filename_hints,
      file_tree_folder_hints,
      file_tree_paths_guess,
      notes
    };
  }

  root.__typstAgentWorkspaceExtract = extract;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
