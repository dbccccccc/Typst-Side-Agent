/**
 * Main-world content script for typst.app. Owns the CodeMirror EditorView
 * access, diagnostic queries, preview capture, and floating attach buttons.
 */
(function () {
  if (window.__typstAgentMainLoaded) return;
  window.__typstAgentMainLoaded = true;

  // ---------- Editor access ----------

  let cachedView = null;

  function findEditorView() {
    if (cachedView && cachedView.state) return cachedView;
    cachedView = null;
    const el = document.querySelector('.cm-content') || document.querySelector('.cm-line');
    if (!el || !el.cmView) return null;
    let node = el.cmView;
    while (node) {
      const view = node.editorView || node.view;
      if (view && view.state && view.dispatch) {
        cachedView = view;
        return view;
      }
      node = node.parent;
    }
    return null;
  }

  function formatDocWithLineNumbers(doc) {
    const w = Math.max(1, String(doc.lines).length);
    const out = [];
    for (let n = 1; n <= doc.lines; n++) {
      out.push(`${String(n).padStart(w, ' ')}|${doc.line(n).text}`);
    }
    return out.join('\n');
  }

  function postContext() {
    const view = findEditorView();
    if (!view) {
      window.postMessage({ type: 'TYPST_AGENT_CONTEXT', error: 'EditorView not found' }, '*');
      return;
    }
    const { state } = view;
    const sel = state.selection.main;
    const headLine = state.doc.lineAt(sel.head);
    let workspace = null;
    try {
      if (typeof globalThis.__typstAgentWorkspaceExtract === 'function') {
        workspace = globalThis.__typstAgentWorkspaceExtract(document);
      }
    } catch (e) {
      workspace = { error: e.message };
    }
    window.postMessage({
      type: 'TYPST_AGENT_CONTEXT',
      fullText: state.doc.toString(),
      numberedFullText: formatDocWithLineNumbers(state.doc),
      cursorPos: sel.head,
      cursorLine: headLine.number,
      cursorColumn: sel.head - headLine.from + 1,
      selectedText: state.sliceDoc(sel.from, sel.to),
      selectionFrom: sel.from,
      selectionTo: sel.to,
      docLength: state.doc.length,
      workspace
    }, '*');
  }

  // ---------- Edit tools ----------

  function insertText(text) {
    const view = findEditorView();
    if (!view) return { ok: false, error: 'EditorView not found' };
    if (typeof text !== 'string') return { ok: false, error: 'insert_at_cursor requires a string "text".' };
    const cursor = view.state.selection.main.head;
    view.dispatch({ changes: { from: cursor, insert: text } });
    return { ok: true };
  }

  function replaceSelection(text) {
    const view = findEditorView();
    if (!view) return { ok: false, error: 'EditorView not found' };
    if (typeof text !== 'string') return { ok: false, error: 'replace_selection requires a string "text".' };
    const { from, to } = view.state.selection.main;
    if (from === to) {
      return { ok: false, error: 'No selection in the editor. Ask the user to select text first, or use replace_lines / search_replace / insert_at_cursor.' };
    }
    view.dispatch({ changes: { from, to, insert: text } });
    return { ok: true, replaced_chars: to - from };
  }

  function toInt(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
    return null;
  }

  function replaceLines(startLineIn, endLineIn, newContent) {
    const view = findEditorView();
    if (!view) return { ok: false, error: 'EditorView not found' };
    const doc = view.state.doc;

    const startLine = toInt(startLineIn);
    const endLineRaw = toInt(endLineIn);
    const endLine = endLineRaw == null ? startLine : endLineRaw;

    if (startLine == null) {
      return {
        ok: false,
        error: 'replace_lines requires an integer "start_line" (1-indexed). Call read_document first to find the line number, then pass start_line, end_line, and new_content.'
      };
    }
    if (typeof newContent !== 'string') {
      return { ok: false, error: 'replace_lines requires a string "new_content".' };
    }
    if (startLine < 1 || endLine < 1 || startLine > endLine) {
      return { ok: false, error: `Invalid line range ${startLine}-${endLine} (must be 1 ≤ start_line ≤ end_line).` };
    }
    if (endLine > doc.lines) {
      return { ok: false, error: `Line ${endLine} is past end of document (document has ${doc.lines} lines).` };
    }
    const from = doc.line(startLine).from;
    const to = doc.line(endLine).to;
    view.dispatch({ changes: { from, to, insert: newContent } });
    return { ok: true, lines_replaced: endLine - startLine + 1 };
  }

  function searchReplace(search, replace) {
    const view = findEditorView();
    if (!view) return { ok: false, error: 'EditorView not found' };
    if (typeof search !== 'string' || search.length === 0) {
      return { ok: false, error: 'search_replace requires a non-empty "search" string.' };
    }
    if (typeof replace !== 'string') {
      return { ok: false, error: 'search_replace requires a "replace" string (use "" to delete).' };
    }
    const content = view.state.doc.toString();
    const idx = content.indexOf(search);
    if (idx === -1) return { ok: false, error: 'Search string not found in document' };
    const second = content.indexOf(search, idx + search.length);
    view.dispatch({ changes: { from: idx, to: idx + search.length, insert: replace } });
    const result = { ok: true };
    if (second !== -1) result.note = 'Replaced the first match; "search" appears more than once. Use patch_document or replace_lines for the other occurrences.';
    return result;
  }

  /**
   * Atomic multi-edit: every edit is matched against the document state captured
   * before the patch starts, then applied in document order. If any edit cannot
   * be matched (or matches more than once when unique=true), the whole patch is
   * rejected and nothing is applied.
   */
  function patchDocument(edits) {
    const view = findEditorView();
    if (!view) return { ok: false, error: 'EditorView not found' };
    if (!Array.isArray(edits) || edits.length === 0) {
      return { ok: false, error: 'patch_document requires a non-empty edits array' };
    }
    const content = view.state.doc.toString();
    const resolved = [];
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i] || {};
      const search = typeof edit.search === 'string' ? edit.search : '';
      const replace = typeof edit.replace === 'string' ? edit.replace : '';
      const unique = edit.unique !== false;
      if (!search) return { ok: false, error: `Edit #${i + 1}: empty "search"` };

      const first = content.indexOf(search);
      if (first === -1) return { ok: false, error: `Edit #${i + 1}: search string not found` };

      if (unique) {
        const second = content.indexOf(search, first + search.length);
        if (second !== -1) return { ok: false, error: `Edit #${i + 1}: search string appears more than once (set unique=false to allow first match)` };
      }
      resolved.push({ from: first, to: first + search.length, insert: replace });
    }

    resolved.sort((a, b) => a.from - b.from);
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i].from < resolved[i - 1].to) {
        return { ok: false, error: `Edit #${i + 1}: overlaps with a previous edit (matched range collides)` };
      }
    }

    view.dispatch({ changes: resolved });
    return { ok: true, edits_applied: resolved.length };
  }

  function executeTool(toolName, args) {
    const a = args || {};
    switch (toolName) {
      case 'replace_lines':     return replaceLines(a.start_line, a.end_line, a.new_content);
      case 'search_replace':    return searchReplace(a.search, a.replace);
      case 'patch_document':    return patchDocument(a.edits);
      case 'insert_at_cursor':  return insertText(typeof a.text === 'string' ? a.text : '');
      case 'replace_selection': return replaceSelection(typeof a.text === 'string' ? a.text : '');
      default: return { ok: false, error: 'Unknown page tool: ' + toolName };
    }
  }

  function executeToolSafely(toolName, args) {
    try {
      const r = executeTool(toolName, args);
      if (r && typeof r === 'object') return r;
      return { ok: false, error: 'Tool returned no result' };
    } catch (e) {
      return { ok: false, error: `Tool "${toolName}" threw: ${e && e.message ? e.message : String(e)}` };
    }
  }

  // ---------- Preview capture ----------

  function getWorkspaceSnapshot() {
    try {
      if (typeof globalThis.__typstAgentWorkspaceExtract === 'function') {
        return globalThis.__typstAgentWorkspaceExtract(document);
      }
    } catch { /* ignore */ }
    return null;
  }

  function findDominantPreviewImage() {
    const ws = getWorkspaceSnapshot();
    const pathStr = ws?.detail_path || '';
    const basename = pathStr ? String(pathStr).split(/[/\\]/).pop() : '';
    const basenameLower = basename.toLowerCase();
    const basenameStem = basenameLower.replace(/\.(png|jpe?g|gif|webp|svg)$/i, '');

    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const candidates = [];
    document.querySelectorAll('img').forEach(img => {
      if (img.closest('.cm-editor')) return;
      const r = img.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
      const area = r.width * r.height;
      if (area < 12000) return;
      let score = area;
      const src = img.currentSrc || img.src || '';
      const hay = (src + ' ' + (img.alt || '')).toLowerCase();
      if (basenameLower && (hay.includes(basenameLower) || hay.includes(basenameStem))) score += 1e15;
      if (/image preview|preview/i.test(img.alt || '')) score += 1e12;
      candidates.push({ img, area, score, r });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? { ...candidates[0], workspace: ws } : null;
  }

  function tryRasterizePreviewImage(img) {
    try {
      const MAX_DIM = 2048;
      let tw = img.naturalWidth || img.width;
      let th = img.naturalHeight || img.height;
      if (!tw || !th) {
        const r = img.getBoundingClientRect();
        tw = Math.max(1, Math.floor(r.width));
        th = Math.max(1, Math.floor(r.height));
      }
      const scale = Math.min(1, MAX_DIM / Math.max(tw, th));
      const outW = Math.max(1, Math.floor(tw * scale));
      const outH = Math.max(1, Math.floor(th * scale));
      const c = document.createElement('canvas');
      c.width = outW;
      c.height = outH;
      c.getContext('2d').drawImage(img, 0, 0, tw, th, 0, 0, outW, outH);
      return { ok: true, dataUrl: c.toDataURL('image/png'), width: outW, height: outH };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function shouldOfferImageQuickAdd(pick) {
    if (!pick) return false;
    const ws = pick.workspace;
    if (ws && ws.preview_kind === 'binary_image_asset') return true;
    if (ws && ws.detail_format && /^(PNG|JPEG|JPG|GIF|WebP|SVG)/i.test(String(ws.detail_format).trim())) return true;
    if (/image preview|preview/i.test(pick.img.alt || '')) return true;
    return false;
  }

  function capturePreview(options) {
    const o = options || {};
    const { preferTypstCanvas, preferAssetImage } = o;

    const reply = (payload) => window.postMessage({ type: 'TYPST_AGENT_PREVIEW', ...payload }, '*');

    if (preferTypstCanvas) {
      const canvas = document.querySelector('canvas');
      if (!canvas) return reply({ error: 'No Typst render canvas found' });
      try { reply({ dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }); }
      catch (e) { reply({ error: e.message }); }
      return;
    }

    if (preferAssetImage) {
      const pick = findDominantPreviewImage();
      if (!pick) return reply({ error: 'No large preview image found. Open an image in the preview column first.' });
      const r = tryRasterizePreviewImage(pick.img);
      if (!r.ok) return reply({ error: r.error || 'Could not rasterize the opened image' });
      return reply({ dataUrl: r.dataUrl, width: r.width, height: r.height });
    }

    const pick = findDominantPreviewImage();
    if (pick && shouldOfferImageQuickAdd(pick)) {
      const r = tryRasterizePreviewImage(pick.img);
      if (r.ok) return reply({ dataUrl: r.dataUrl, width: r.width, height: r.height });
    }
    const canvas = document.querySelector('canvas');
    if (!canvas) return reply({ error: pick ? 'Image raster failed and no canvas found' : 'No canvas found' });
    try { reply({ dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }); }
    catch (e) { reply({ error: e.message }); }
  }

  // ---------- Diagnostics ----------

  function strategyLintRanges(view) {
    const results = [];
    const editor = view.dom;
    const ranges = editor.querySelectorAll(
      '.cm-lintRange, .cm-lintRange-error, .cm-lintRange-warning, .cm-lintRange-info, [class*="cm-lintRange"]'
    );
    ranges.forEach(el => {
      try {
        const pos = view.posAtDOM(el);
        if (pos == null) return;
        const severity = el.className.includes('error') ? 'error'
          : el.className.includes('warning') ? 'warning' : 'info';
        const line = view.state.doc.lineAt(pos);
        const snippet = view.state.sliceDoc(pos, Math.min(pos + 40, view.state.doc.length)).split('\n')[0];
        results.push({
          severity,
          message: `${severity}: near "${snippet}"`,
          line: line.number,
          column: pos - line.from + 1
        });
      } catch { /* ignore */ }
    });
    const seen = new Set();
    return results.filter(r => {
      const key = `${r.line}:${r.severity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function strategyImprovePanel() {
    if (typeof globalThis.__typstAgentImproveExtract === 'function') {
      return globalThis.__typstAgentImproveExtract(document);
    }
    return [];
  }

  function mergeDiagnostics(lintRanges, improvePanel) {
    // The Improve-panel strategy carries the real Typst error text
    // (e.g. "Unexpected argument: leading: 1.4"), while the lint-range
    // strategy carries precise line + column info from CodeMirror's
    // underlines. Combine them so the model always gets the best of both.
    const out = [];
    const improveByLine = new Map();
    for (const d of improvePanel) {
      if (!d || typeof d.line !== 'number') continue;
      if (!improveByLine.has(d.line)) improveByLine.set(d.line, []);
      improveByLine.get(d.line).push(d);
    }

    const usedImproveKeys = new Set();
    for (const l of lintRanges) {
      const bucket = improveByLine.get(l.line) || [];
      // CM6 lintRanges are the compiler's error/warning underlines; pairing
      // them with a spelling entry would let the advisory spelling kind/
      // severity overwrite a real compiler diagnostic that happens to sit on
      // the same line. Skip spelling entries here — they're emitted below in
      // the unpaired pass.
      let match = bucket.find(d => d.kind !== 'spelling' && d.severity === l.severity && !usedImproveKeys.has(d));
      if (!match) match = bucket.find(d => d.kind !== 'spelling' && !usedImproveKeys.has(d));
      if (match) {
        usedImproveKeys.add(match);
        out.push({
          severity: match.severity || l.severity,
          message: match.message || l.message,
          line: l.line,
          column: l.column ?? match.column ?? null,
          kind: match.kind || 'typst',
          original: match.original || null,
          suggestion: match.suggestion || null
        });
      } else {
        out.push(l);
      }
    }

    for (const d of improvePanel) {
      if (usedImproveKeys.has(d)) continue;
      out.push(d);
    }

    const seen = new Set();
    return out.filter(d => {
      const key = `${d.line}|${d.severity}|${(d.message || '').slice(0, 160)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (a.line || 0) - (b.line || 0));
  }

  /**
   * True when the typst.app "Improve" sidebar is actually mounted on the left.
   *
   * Extraction alone can't tell an empty Improve panel from a closed one, so we
   * look for section markers ("Compiler errors", "Misspellings", "No spelling
   * mistakes", …) that typst.app only renders while the panel is visible.
   */
  function detectImprovePanel(doc) {
    const win = doc.defaultView || window;
    const vw = win.innerWidth || 1200;
    const cutoff = Math.max(360, vw * 0.5);
    const markerRe = /^(No\s+compiler\s+(errors?|warnings?)|No\s+spelling\s+mistakes|Misspellings|Compiler\s+(errors?|warnings?)|Improve)$/i;
    const nodes = doc.querySelectorAll('span, div, p, h1, h2, h3, h4, button, strong, em, a, li');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      let own = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) own += node.nodeValue;
      }
      own = own.replace(/\s+/g, ' ').trim();
      if (!own || own.length > 40) continue;
      if (!markerRe.test(own)) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch { continue; }
      if (!r || (r.width === 0 && r.height === 0)) continue;
      if (r.left > cutoff) continue;
      return true;
    }
    return false;
  }

  function postProbe() {
    const view = findEditorView();
    const hasEditor = !!view;
    const hasSelection = hasEditor && !view.state.selection.main.empty;

    let canvasArea = 0;
    document.querySelectorAll('canvas').forEach(c => {
      canvasArea = Math.max(canvasArea, (c.width || 0) * (c.height || 0));
    });
    const hasTypstCanvas = canvasArea > 20000;

    let hasPreviewImage = false;
    try {
      const pick = findDominantPreviewImage();
      hasPreviewImage = !!(pick && shouldOfferImageQuickAdd(pick));
    } catch { /* ignore */ }

    const improvePanel = detectImprovePanel(document);

    window.postMessage({
      type: 'TYPST_AGENT_PROBE_RESULT',
      editor: hasEditor,
      selection: hasSelection,
      typstCanvas: hasTypstCanvas,
      previewImage: hasPreviewImage,
      improvePanel
    }, '*');
  }

  function getDiagnostics() {
    const view = findEditorView();
    if (!view) {
      window.postMessage({ type: 'TYPST_AGENT_DIAGNOSTICS', diagnostics: [], error: 'EditorView not found' }, '*');
      return;
    }
    const lintRanges = strategyLintRanges(view);
    const improve = strategyImprovePanel();
    const results = mergeDiagnostics(lintRanges, improve);
    window.postMessage({ type: 'TYPST_AGENT_DIAGNOSTICS', diagnostics: results }, '*');
  }

  // ---------- Floating attach buttons ----------

  const SEL_FLOAT_ID = 'typst-side-agent-selection-float';
  const IMG_FLOAT_ID = 'typst-side-agent-image-float';
  const ACCENT = 'rgb(124, 124, 240)';

  function styleFloatButton(el) {
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '2147483646',
      display: 'none',
      padding: '5px 11px',
      fontSize: '12px',
      fontWeight: '600',
      lineHeight: '1.2',
      borderRadius: '8px',
      border: `1px solid ${ACCENT}`,
      background: 'rgba(25,24,31,0.96)',
      color: '#E5E5FF',
      boxShadow: '0 4px 14px rgba(0,0,0,.35)',
      cursor: 'pointer',
      pointerEvents: 'auto',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      backdropFilter: 'blur(8px)'
    });
  }

  function getOrCreateSelFloatBtn() {
    let el = document.getElementById(SEL_FLOAT_ID);
    if (el) return el;
    el = document.createElement('button');
    el.id = SEL_FLOAT_ID;
    el.type = 'button';
    el.textContent = 'Add to agent';
    el.setAttribute('aria-label', 'Send the current editor selection to Typst Side Agent');
    styleFloatButton(el);
    el.addEventListener('mousedown', e => e.preventDefault(), true);
    el.addEventListener('pointerdown', e => e.stopPropagation(), true);
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      window.postMessage({ type: 'TYPST_AGENT_QUICK_SELECTION' }, '*');
    });
    document.body.appendChild(el);
    return el;
  }

  function hideEl(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  function updateSelectionFloatButton() {
    const view = findEditorView();
    if (!view) { hideEl(SEL_FLOAT_ID); return; }
    const sel = view.state.selection.main;
    if (sel.empty) { hideEl(SEL_FLOAT_ID); return; }
    let coords;
    try { coords = view.coordsAtPos(sel.to, 1); } catch { hideEl(SEL_FLOAT_ID); return; }
    if (!coords || typeof coords.left !== 'number') { hideEl(SEL_FLOAT_ID); return; }
    const btn = getOrCreateSelFloatBtn();
    const gap = 6;
    let left = coords.right + gap;
    let top = coords.top;
    btn.style.display = 'block';
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = `${Math.round(top)}px`;
    const rect = btn.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      left = Math.max(8, coords.left - rect.width - gap);
      btn.style.left = `${Math.round(left)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      top = Math.max(8, coords.bottom - rect.height);
      btn.style.top = `${Math.round(top)}px`;
    }
  }

  function getOrCreateImageFloatBtn() {
    let el = document.getElementById(IMG_FLOAT_ID);
    if (el) return el;
    el = document.createElement('button');
    el.id = IMG_FLOAT_ID;
    el.type = 'button';
    el.textContent = 'Add image to agent';
    el.setAttribute('aria-label', 'Add the previewed image to Typst Side Agent attachments');
    styleFloatButton(el);
    el.addEventListener('mousedown', e => e.preventDefault(), true);
    el.addEventListener('pointerdown', e => e.stopPropagation(), true);
    let last = 0;
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - last < 900) return;
      last = now;
      window.postMessage({ type: 'TYPST_AGENT_QUICK_IMAGE_PREVIEW' }, '*');
    });
    document.body.appendChild(el);
    return el;
  }

  function updateImageFloatButton() {
    const view = findEditorView();
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) { hideEl(IMG_FLOAT_ID); return; }
    }
    const pick = findDominantPreviewImage();
    if (!pick || !shouldOfferImageQuickAdd(pick)) { hideEl(IMG_FLOAT_ID); return; }
    const r = pick.img.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) { hideEl(IMG_FLOAT_ID); return; }
    const btn = getOrCreateImageFloatBtn();
    const gap = 8;
    let left = Math.round(r.right + gap);
    let top = Math.round(r.top + 8);
    btn.style.display = 'block';
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    const br = btn.getBoundingClientRect();
    if (br.right > window.innerWidth - 8) {
      left = Math.max(8, Math.round(r.right - br.width - gap));
      btn.style.left = `${left}px`;
    }
    if (br.bottom > window.innerHeight - 8) {
      top = Math.max(8, Math.round(r.bottom - br.height - gap));
      btn.style.top = `${top}px`;
    }
  }

  setInterval(() => {
    updateSelectionFloatButton();
    updateImageFloatButton();
  }, 220);

  // ---------- Message bridge ----------

  window.addEventListener('message', (evt) => {
    if (evt.source !== window || !evt.data || typeof evt.data.type !== 'string') return;
    switch (evt.data.type) {
      case 'TYPST_AGENT_GET_CONTEXT': postContext(); break;
      case 'TYPST_AGENT_GET_DIAGNOSTICS': getDiagnostics(); break;
      case 'TYPST_AGENT_GET_PROBE': postProbe(); break;
      case 'TYPST_AGENT_GET_PREVIEW':
        capturePreview({
          preferTypstCanvas: !!evt.data.preferTypstCanvas,
          preferAssetImage: !!evt.data.preferAssetImage
        });
        break;
      case 'TYPST_AGENT_EXECUTE_TOOL': {
        const result = executeToolSafely(evt.data.toolName, evt.data.args || {});
        window.postMessage({ type: 'TYPST_AGENT_TOOL_RESULT', callId: evt.data.callId, result }, '*');
        break;
      }
    }
  });
})();
