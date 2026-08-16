/**
 * Main-world content script for typst.app. Owns the CodeMirror EditorView
 * access, diagnostic queries, preview capture, and floating attach buttons.
 */
(function () {
  const bridge = globalThis.__typstAgentBridgeProtocol;
  if (!bridge) return;
  const RUNTIME_VERSION = 11;
  const previousRuntime = window.__typstAgentMainRuntime;
  if (previousRuntime?.version === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch { /* obsolete runtime */ }
  if (!previousRuntime && window.__typstAgentMainLoaded) {
    try { globalThis.__typstAgentFloatController?.stop?.(); } catch { /* legacy controller */ }
    delete globalThis.__typstAgentFloatController;
    document.getElementById('typst-side-agent-selection-float')?.remove();
    document.getElementById('typst-side-agent-image-float')?.remove();
  }
  window.__typstAgentMainLoaded = true;

  const { TYPES } = bridge;
  const bridgeNonces = new Set();
  const MAX_BRIDGE_NONCES = 8;
  const MAX_PAGE_DOCUMENT_CHARS = 1_048_576;
  const MAX_PAGE_SELECTION_CHARS = 65_536;
  const MAX_PAGE_WORKSPACE_CHARS = 65_536;
  const MAX_PAGE_DIAGNOSTICS = 200;
  const MAX_PAGE_DIAGNOSTICS_CHARS = 262_144;
  const MAX_PREVIEW_DATA_URL_CHARS = 2_097_152;
  let activeBridgeNonce = null;
  const cancelledPageRequests = new Map();

  // ---------- Editor access ----------

  let cachedView = null;
  const editorTokens = new WeakMap();

  function editorToken(view) {
    let token = editorTokens.get(view);
    if (!token) {
      token = crypto.randomUUID();
      editorTokens.set(view, token);
    }
    return token;
  }

  function findEditorView() {
    if (cachedView?.dom?.isConnected && cachedView.state && cachedView.dispatch) return cachedView;
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

  function formatDocRangeWithLineNumbers(doc, startLine, endLine, maxChars) {
    const w = Math.max(1, String(doc.lines).length);
    const out = [];
    let chars = 0;
    let lastLine = startLine - 1;
    let truncated = false;
    for (let n = startLine; n <= endLine; n++) {
      const line = `${String(n).padStart(w, ' ')}|${doc.line(n).text}`;
      const separator = out.length ? 1 : 0;
      if (chars + separator + line.length > maxChars) {
        if (out.length === 0) {
          out.push(line.slice(0, maxChars));
          lastLine = n;
        }
        truncated = true;
        break;
      }
      out.push(line);
      chars += separator + line.length;
      lastLine = n;
    }
    return {
      text: out.join('\n'),
      endLine: Math.max(startLine, lastLine),
      truncated,
      nextStartLine: truncated && lastLine < endLine ? lastLine + 1 : null
    };
  }

  function boundedWorkspace(value) {
    if (value == null) return null;
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length <= MAX_PAGE_WORKSPACE_CHARS) return value;
    } catch { /* omit non-serializable page data */ }
    return { error: 'Workspace metadata was omitted because it exceeded the bridge limit.' };
  }

  const DEFAULT_EDITOR_FILE_LABEL = 'Current Typst document';
  const PROJECT_FILE_BASENAME_RE = /\.[a-z0-9][a-z0-9+_-]{0,31}$/i;

  function normalizeProjectRelativePath(value) {
    let relativePath = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
    relativePath = relativePath.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!relativePath || relativePath.length > 240 || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) return null;
    const segments = relativePath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\0\r\n]/.test(segment))) return null;
    return PROJECT_FILE_BASENAME_RE.test(segments.at(-1) || '') ? relativePath : null;
  }

  function activeEditorFile(workspace) {
    const value = workspace?.active_editor_file;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const relativePath = normalizeProjectRelativePath(value.relativePath);
    if (!relativePath) return null;
    return { ...value, relativePath };
  }

  function editorFileLabel(workspace) {
    if (!workspace || typeof workspace !== 'object') return DEFAULT_EDITOR_FILE_LABEL;
    const active = activeEditorFile(workspace);
    if (active) return active.relativePath;
    const candidates = [workspace.focused_element_file_hint, workspace.detail_path];
    const label = candidates.map(normalizeProjectRelativePath).find(Boolean);
    return label || DEFAULT_EDITOR_FILE_LABEL;
  }

  function liveEditorFileLabel() {
    try {
      return editorFileLabel(typeof globalThis.__typstAgentWorkspaceExtract === 'function'
        ? globalThis.__typstAgentWorkspaceExtract(document, { includeProjectTree: false })
        : null);
    } catch {
      return DEFAULT_EDITOR_FILE_LABEL;
    }
  }

  function readWorkspaceContext(options = {}) {
    let workspace = null;
    try {
      if (typeof globalThis.__typstAgentWorkspaceExtract === 'function') {
        workspace = boundedWorkspace(globalThis.__typstAgentWorkspaceExtract(document, options));
      }
    } catch (e) {
      workspace = { error: String(e?.message || e).slice(0, 1_000) };
    }
    return workspace;
  }

  function getContext(options = {}) {
    const projection = options.projection || 'full';
    const workspace = readWorkspaceContext({ includeProjectTree: projection === 'identity' });
    if (projection === 'identity') return { workspace };
    const view = findEditorView();
    if (!view) {
      return { error: 'EditorView not found', workspace };
    }
    const { state } = view;
    const sel = state.selection.main;
    const headLine = state.doc.lineAt(sel.head);
    const selectedLength = Math.max(0, sel.to - sel.from);
    const common = {
      cursorPos: sel.head,
      cursorLine: headLine.number,
      cursorColumn: sel.head - headLine.from + 1,
      selectedText: state.sliceDoc(sel.from, Math.min(sel.to, sel.from + MAX_PAGE_SELECTION_CHARS)),
      selectionTruncated: selectedLength > MAX_PAGE_SELECTION_CHARS,
      selectionFrom: sel.from,
      selectionTo: sel.to,
      docLength: state.doc.length,
      lineCount: state.doc.lines,
      editorToken: editorToken(view),
      workspace
    };
    if (projection === 'numbered') {
      const startLine = Math.min(Math.max(options.startLine || 1, 1), state.doc.lines || 1);
      const requestedEnd = Math.min(Math.max(options.endLine || state.doc.lines, startLine), state.doc.lines || startLine);
      const maxChars = Math.min(Math.max(options.maxChars || 28_000, 1), 64_000);
      const range = formatDocRangeWithLineNumbers(state.doc, startLine, requestedEnd, maxChars);
      return {
        ...common,
        numberedDocument: range.text,
        startLine,
        endLine: range.endLine,
        truncated: range.truncated,
        ...(range.nextStartLine == null ? {} : { nextStartLine: range.nextStartLine })
      };
    }
    if (projection === 'edit' && state.doc.length > MAX_PAGE_DOCUMENT_CHARS) {
      return { error: `The document exceeds the ${MAX_PAGE_DOCUMENT_CHARS}-character safe edit limit.`, docLength: state.doc.length, lineCount: state.doc.lines };
    }
    const truncated = state.doc.length > MAX_PAGE_DOCUMENT_CHARS;
    return {
      ...common,
      fullText: state.sliceDoc(0, Math.min(state.doc.length, MAX_PAGE_DOCUMENT_CHARS)),
      truncated
    };
  }

  const INLINE_DIFF_STYLE_ID = 'typst-side-agent-inline-diff-style';
  const INLINE_DIFF_LAYER_ID = 'typst-side-agent-inline-diff-rows';
  const MAX_INLINE_DIFF_ROWS = 2000;
  let activeEditPreview = null;

  function validatePreparedEditSnapshot(expectedText, expectedEditorToken, expectedFileLabel, changes) {
    const view = findEditorView();
    if (!view) return { ok: false, code: 'EDITOR_UNAVAILABLE', error: 'EditorView not found' };
    if (typeof expectedText !== 'string' || !Array.isArray(changes) || changes.length === 0 || changes.length > 128) {
      return { ok: false, code: 'INVALID_PREPARED_EDIT', error: 'Prepared edit payload is invalid.' };
    }
    const currentText = view.state.doc.toString();
    const currentFileLabel = liveEditorFileLabel();
    if (typeof expectedFileLabel !== 'string' || !expectedFileLabel || (
      expectedFileLabel !== DEFAULT_EDITOR_FILE_LABEL && currentFileLabel !== expectedFileLabel
    )) {
      return {
        ok: false,
        code: 'STALE_EDIT_PREVIEW',
        staleReason: 'file',
        error: 'The focused file changed after this diff was prepared. Ask the agent to retry so you can review the correct file.'
      };
    }
    if (typeof expectedEditorToken !== 'string' || editorToken(view) !== expectedEditorToken) {
      return {
        ok: false,
        code: 'STALE_EDIT_PREVIEW',
        staleReason: 'editor',
        error: 'The active editor changed after this diff was prepared. Ask the agent to retry so you can review the correct file.'
      };
    }
    if (currentText !== expectedText) {
      return {
        ok: false,
        code: 'STALE_EDIT_PREVIEW',
        staleReason: 'document',
        error: 'The document changed after this diff was prepared. Ask the agent to retry so you can review a fresh diff.'
      };
    }
    let previousTo = 0;
    let insertedChars = 0;
    const normalized = [];
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (!change || !Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to > currentText.length || typeof change.insert !== 'string') {
        return { ok: false, code: 'INVALID_PREPARED_EDIT', error: `Prepared edit #${index + 1} has an invalid range.` };
      }
      if (index > 0 && change.from < previousTo) {
        return { ok: false, code: 'INVALID_PREPARED_EDIT', error: `Prepared edit #${index + 1} overlaps a previous range.` };
      }
      insertedChars += change.insert.length;
      if (insertedChars > 1_000_000) return { ok: false, code: 'INVALID_PREPARED_EDIT', error: 'Prepared edit inserts too much text.' };
      previousTo = change.to;
      normalized.push({ from: change.from, to: change.to, insert: change.insert });
    }
    return { ok: true, view, changes: normalized };
  }

  function installInlineDiffStyle() {
    let style = document.getElementById(INLINE_DIFF_STYLE_ID);
    if (style) return style;
    style = document.createElement('style');
    style.id = INLINE_DIFF_STYLE_ID;
    style.textContent = `
      #${INLINE_DIFF_LAYER_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        overflow: hidden;
        pointer-events: none;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-surface {
        position: absolute;
        overflow: auto;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, .12);
        background: var(--tsa-inline-diff-background, rgb(25, 24, 31));
        outline: none;
        pointer-events: auto;
        scrollbar-gutter: stable;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-header {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 30px;
        padding: 4px 10px;
        box-sizing: border-box;
        border-bottom: 1px solid rgba(255, 255, 255, .12);
        background:
          linear-gradient(rgba(31, 30, 39, .86), rgba(31, 30, 39, .86)),
          var(--tsa-inline-diff-background, rgb(25, 24, 31));
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-stats {
        display: flex;
        gap: 10px;
        font-weight: 700;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-stat-add { color: #56d364; }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-stat-delete { color: #ff7b72; }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-body {
        min-width: max-content;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-row {
        display: grid;
        grid-template-columns: 44px 44px 22px minmax(max-content, 1fr);
        min-height: var(--tsa-inline-diff-line-height, 18px);
        box-sizing: border-box;
        white-space: pre;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-line-number {
        padding-inline-end: 7px;
        color: rgba(240, 243, 246, .58);
        text-align: right;
        user-select: none;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-marker {
        text-align: center;
        user-select: none;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-code {
        padding-inline-end: 12px;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-insert {
        background:
          linear-gradient(rgba(46, 160, 67, .32), rgba(46, 160, 67, .32)),
          var(--tsa-inline-diff-background, rgb(25, 24, 31));
        box-shadow: inset 3px 0 #2ea043;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-delete {
        background:
          linear-gradient(rgba(248, 81, 73, .28), rgba(248, 81, 73, .28)),
          var(--tsa-inline-diff-background, rgb(25, 24, 31));
        box-shadow: inset 3px 0 #f85149;
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-context {
        background: var(--tsa-inline-diff-background, rgb(25, 24, 31));
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-hunk,
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-notice {
        display: block;
        min-height: var(--tsa-inline-diff-line-height, 18px);
        padding-inline: 10px;
        box-sizing: border-box;
        line-height: var(--tsa-inline-diff-line-height, 18px);
        color: rgba(240, 243, 246, .8);
        background:
          linear-gradient(rgba(67, 63, 90, .72), rgba(67, 63, 90, .72)),
          var(--tsa-inline-diff-background, rgb(25, 24, 31));
      }
      #${INLINE_DIFF_LAYER_ID} .tsa-inline-diff-notice {
        color: #f1c66d;
        background:
          linear-gradient(rgba(241, 198, 109, .12), rgba(241, 198, 109, .12)),
          var(--tsa-inline-diff-background, rgb(25, 24, 31));
        font-style: italic;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function previewSurface(view) {
    return view.scrollDOM || view.dom?.closest?.('.cm-editor') || view.contentDOM?.closest?.('.cm-editor') || view.dom || view.contentDOM || null;
  }

  function isOpaqueCssColor(value) {
    const color = String(value || '').trim().toLowerCase();
    if (!color || color === 'transparent') return false;
    const commaAlpha = color.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
    if (commaAlpha) return Number(commaAlpha[1]) >= 0.999;
    const slashAlpha = color.match(/\/\s*([\d.]+)(%)?\s*\)$/);
    if (slashAlpha) return slashAlpha[2] ? Number(slashAlpha[1]) >= 99.9 : Number(slashAlpha[1]) >= 0.999;
    return true;
  }

  function editorBackgroundColor(element) {
    if (typeof getComputedStyle !== 'function') return 'rgb(25, 24, 31)';
    for (let current = element; current; current = current.parentElement) {
      const color = getComputedStyle(current).backgroundColor;
      if (isOpaqueCssColor(color)) return color;
    }
    return 'rgb(25, 24, 31)';
  }

  function ensureDirectDiffSurface(preview) {
    let layer = preview.layer;
    if (!layer?.isConnected) {
      document.getElementById(INLINE_DIFF_LAYER_ID)?.remove();
      layer = document.createElement('div');
      layer.id = INLINE_DIFF_LAYER_ID;
      const surface = document.createElement('section');
      surface.className = 'tsa-inline-diff-surface';
      surface.tabIndex = 0;
      surface.setAttribute('role', 'region');
      surface.setAttribute('aria-label', `Proposed changes to ${preview.diffPreview.fileLabel}`);
      layer.appendChild(surface);
      (document.body || document.documentElement).appendChild(layer);
      preview.layer = layer;
      preview.surface = surface;
    }
    const surface = previewSurface(preview.view);
    const rect = surface?.getBoundingClientRect?.();
    if (rect) {
      preview.surface.style.left = `${rect.left}px`;
      preview.surface.style.top = `${rect.top}px`;
      preview.surface.style.width = `${Math.max(0, rect.width)}px`;
      preview.surface.style.height = `${Math.max(0, rect.height)}px`;
    }
    const content = preview.view.contentDOM || document.querySelector('.cm-content');
    const contentStyle = typeof getComputedStyle === 'function' && content ? getComputedStyle(content) : null;
    if (contentStyle) {
      preview.surface.style.fontFamily = contentStyle.fontFamily;
      preview.surface.style.fontSize = contentStyle.fontSize;
      preview.surface.style.fontWeight = contentStyle.fontWeight;
      preview.surface.style.lineHeight = contentStyle.lineHeight === 'normal' ? '18px' : contentStyle.lineHeight;
      preview.surface.style.color = contentStyle.color;
      preview.surface.style.setProperty('--tsa-inline-diff-line-height', contentStyle.lineHeight === 'normal' ? '18px' : contentStyle.lineHeight);
    }
    const backgroundColor = editorBackgroundColor(preview.view.dom || content);
    preview.surface.style.backgroundColor = backgroundColor;
    preview.surface.style.setProperty('--tsa-inline-diff-background', backgroundColor);
    return preview.surface;
  }

  function diffSurfaceSpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  function renderDiffSurface(preview, surface) {
    const header = document.createElement('div');
    header.className = 'tsa-inline-diff-header';
    header.appendChild(diffSurfaceSpan('tsa-inline-diff-file', preview.diffPreview.fileLabel));
    const stats = document.createElement('span');
    stats.className = 'tsa-inline-diff-stats';
    stats.append(
      diffSurfaceSpan('tsa-inline-diff-stat-add', `+${preview.diffPreview.additions}`),
      diffSurfaceSpan('tsa-inline-diff-stat-delete', `−${preview.diffPreview.deletions}`)
    );
    header.appendChild(stats);
    const body = document.createElement('div');
    body.className = 'tsa-inline-diff-body';
    let renderedRows = 0;
    let renderedAdditions = 0;
    let renderedDeletions = 0;
    let truncated = false;
    for (const hunk of preview.diffPreview.hunks) {
      if (renderedRows >= MAX_INLINE_DIFF_ROWS) {
        truncated = true;
        break;
      }
      const hunkHeader = document.createElement('div');
      hunkHeader.className = 'tsa-inline-diff-hunk';
      hunkHeader.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      body.appendChild(hunkHeader);
      for (const sourceRow of hunk.rows) {
        if (renderedRows >= MAX_INLINE_DIFF_ROWS) {
          truncated = true;
          break;
        }
        const row = document.createElement('div');
        row.className = `tsa-inline-diff-row tsa-inline-diff-${sourceRow.kind}`;
        row.append(
          diffSurfaceSpan('tsa-inline-diff-line-number', sourceRow.oldLine == null ? '' : String(sourceRow.oldLine)),
          diffSurfaceSpan('tsa-inline-diff-line-number', sourceRow.newLine == null ? '' : String(sourceRow.newLine)),
          diffSurfaceSpan('tsa-inline-diff-marker', sourceRow.kind === 'insert' ? '+' : sourceRow.kind === 'delete' ? '−' : ' '),
          diffSurfaceSpan('tsa-inline-diff-code', sourceRow.text)
        );
        body.appendChild(row);
        renderedRows += 1;
        if (sourceRow.kind === 'insert') renderedAdditions += 1;
        if (sourceRow.kind === 'delete') renderedDeletions += 1;
      }
      if (truncated) break;
    }
    if (truncated) {
      const notice = document.createElement('div');
      notice.className = 'tsa-inline-diff-notice';
      notice.textContent = '… This editor preview is truncated; review the complete diff in the side panel.';
      body.appendChild(notice);
    }
    surface.replaceChildren(header, body);
    return {
      shown: renderedAdditions + renderedDeletions > 0,
      additions: renderedAdditions,
      deletions: renderedDeletions,
      truncated
    };
  }

  function renderInlineEditPreview(preview) {
    if (activeEditPreview !== preview) return { shown: false, additions: 0, deletions: 0, truncated: false };
    const currentView = findEditorView();
    const stale = currentView !== preview.view || editorToken(preview.view) !== preview.editorToken || preview.view.state.doc !== preview.expectedDoc || (
      preview.expectedFileLabel !== DEFAULT_EDITOR_FILE_LABEL && liveEditorFileLabel() !== preview.expectedFileLabel
    );
    preview.stale = stale;
    const surface = ensureDirectDiffSurface(preview);
    if (stale) {
      if (!preview.staleRendered) {
        const notice = document.createElement('div');
        notice.className = 'tsa-inline-diff-notice';
        notice.textContent = 'The document changed after this preview was prepared. Reject it and ask the agent to retry.';
        surface.replaceChildren(notice);
        preview.staleRendered = true;
      }
      return { shown: false, additions: 0, deletions: 0, truncated: false, stale: true };
    }
    if (!preview.surfaceRendered) {
      preview.renderStatus = renderDiffSurface(preview, surface);
      preview.surfaceRendered = true;
    }
    return preview.renderStatus;
  }

  function scheduleInlineEditPreview(preview) {
    if (activeEditPreview !== preview || preview.frame != null) return;
    const raf = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 16));
    preview.frame = raf(() => {
      preview.frame = null;
      renderInlineEditPreview(preview);
    });
  }

  function clearPreparedEditPreview(runId = null, callId = null) {
    const preview = activeEditPreview;
    if (!preview || (runId != null && preview.runId !== runId) || (callId != null && preview.callId !== callId)) return { ok: true, cleared: false };
    activeEditPreview = null;
    for (const cleanup of preview.cleanups) {
      try { cleanup(); } catch { /* page is changing */ }
    }
    if (preview.frame != null && typeof globalThis.cancelAnimationFrame === 'function') cancelAnimationFrame(preview.frame);
    preview.layer?.remove();
    preview.layer = null;
    preview.surface = null;
    document.getElementById(INLINE_DIFF_STYLE_ID)?.remove();
    return { ok: true, cleared: true };
  }

  function showPreparedEditPreview(runId, expectedText, expectedEditorToken, expectedFileLabel, changes, callId, diffPreview) {
    const checked = validatePreparedEditSnapshot(expectedText, expectedEditorToken, expectedFileLabel, changes);
    if (!checked.ok) return checked;
    if (typeof runId !== 'string' || !runId) return { ok: false, code: 'INVALID_RUN_ID', error: 'Inline preview requires a run identity.' };
    if (!diffPreview || diffPreview.kind !== 'unified-diff' || !Array.isArray(diffPreview.hunks) || diffPreview.hunks.length === 0) {
      return { ok: false, code: 'INVALID_PREPARED_EDIT', error: 'Inline diff data is missing.' };
    }
    if (activeEditPreview && (activeEditPreview.runId !== runId || activeEditPreview.callId !== callId)) {
      return { ok: false, code: 'EDIT_PREVIEW_BUSY', error: 'Another run already owns the inline editor preview.' };
    }
    clearPreparedEditPreview(runId, callId);
    try {
      installInlineDiffStyle();
      const preview = {
        runId,
        callId,
        expectedText,
        editorToken: expectedEditorToken,
        expectedFileLabel,
        changes: checked.changes,
        diffPreview,
        view: checked.view,
        expectedDoc: checked.view.state.doc,
        layer: null,
        surface: null,
        surfaceRendered: false,
        staleRendered: false,
        renderStatus: null,
        stale: false,
        frame: null,
        cleanups: []
      };
      activeEditPreview = preview;
      const schedule = () => scheduleInlineEditPreview(preview);
      const listen = (target, type, options) => {
        if (!target?.addEventListener) return;
        target.addEventListener(type, schedule, options);
        preview.cleanups.push(() => target.removeEventListener(type, schedule, options));
      };
      listen(window, 'resize', { passive: true });
      listen(window, 'scroll', { passive: true, capture: true });
      listen(previewSurface(checked.view), 'scroll', { passive: true });
      if (typeof MutationObserver === 'function' && checked.view.contentDOM) {
        const observer = new MutationObserver(schedule);
        observer.observe(checked.view.contentDOM, { childList: true, subtree: true, characterData: true });
        preview.cleanups.push(() => observer.disconnect());
      }
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(schedule);
        const surface = previewSurface(checked.view);
        if (surface) observer.observe(surface);
        preview.cleanups.push(() => observer.disconnect());
      }
      const renderStatus = renderInlineEditPreview(preview);
      scheduleInlineEditPreview(preview);
      const warning = !renderStatus.shown
        ? 'The inline editor preview could not place any changed rows. Review the complete diff in the side panel.'
        : renderStatus.truncated
          ? 'The inline editor preview is truncated. Review the complete diff in the side panel.'
          : undefined;
      return {
        ok: true,
        shown: renderStatus.shown,
        presentation: 'editor-diff-surface',
        changes_previewed: checked.changes.length,
        additions_rendered: renderStatus.additions,
        deletions_rendered: renderStatus.deletions,
        truncated: renderStatus.truncated,
        ...(warning ? { warning } : {})
      };
    } catch (error) {
      clearPreparedEditPreview(runId, callId);
      document.getElementById(INLINE_DIFF_STYLE_ID)?.remove();
      return { ok: true, shown: false, warning: `Inline editor preview is unavailable: ${error?.message || String(error)}` };
    }
  }

  /** Apply only the exact change set the user reviewed against the exact source they saw. */
  function applyPreparedEdit(runId, callId, expectedText, expectedEditorToken, expectedFileLabel, changes) {
    if (activeEditPreview && (activeEditPreview.runId !== runId || activeEditPreview.callId !== callId)) {
      return { ok: false, code: 'EDIT_PREVIEW_BUSY', error: 'Another run owns the active inline editor preview.' };
    }
    const checked = validatePreparedEditSnapshot(expectedText, expectedEditorToken, expectedFileLabel, changes);
    if (!checked.ok) return checked;
    checked.view.dispatch({ changes: checked.changes });
    return { ok: true, edits_applied: checked.changes.length, reviewed_diff: true };
  }

  // ---------- Preview capture ----------

  let workspaceCache;
  let dominantImageCache;

  function getWorkspaceSnapshot() {
    if (workspaceCache !== undefined) return workspaceCache;
    try {
      if (typeof globalThis.__typstAgentWorkspaceExtract === 'function') {
        workspaceCache = globalThis.__typstAgentWorkspaceExtract(document, { includeProjectTree: false });
        return workspaceCache;
      }
    } catch { /* ignore */ }
    workspaceCache = null;
    return workspaceCache;
  }

  function findDominantPreviewImage() {
    if (dominantImageCache !== undefined) return dominantImageCache;
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
    dominantImageCache = candidates.length ? { ...candidates[0], workspace: ws } : null;
    return dominantImageCache;
  }

  function rasterizePreviewSource(source, sourceWidth, sourceHeight) {
    try {
      const MAX_DIM = 2048;
      let scale = Math.min(1, MAX_DIM / Math.max(sourceWidth, sourceHeight));
      for (let attempt = 0; attempt < 7; attempt++) {
        const width = Math.max(1, Math.floor(sourceWidth * scale));
        const height = Math.max(1, Math.floor(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
        for (const quality of [0.9, 0.78, 0.64]) {
          const dataUrl = canvas.toDataURL('image/webp', quality);
          if (dataUrl.length <= MAX_PREVIEW_DATA_URL_CHARS) {
            return { ok: true, dataUrl, width, height, mimeType: 'image/webp' };
          }
        }
        scale *= 0.72;
      }
      return { ok: false, error: 'Preview image exceeds the 2 MiB bridge limit after resizing.' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 2_000) };
    }
  }

  function tryRasterizePreviewImage(img) {
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;
    if (!width || !height) {
      const rect = img.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
    }
    return rasterizePreviewSource(img, width, height);
  }

  function tryRasterizeCanvas(canvas) {
    const width = Math.max(1, Number(canvas.width) || 1);
    const height = Math.max(1, Number(canvas.height) || 1);
    return rasterizePreviewSource(canvas, width, height);
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

    const reply = payload => payload;

    if (preferTypstCanvas) {
      const canvas = document.querySelector('canvas');
      if (!canvas) return reply({ error: 'No Typst render canvas found' });
      const result = tryRasterizeCanvas(canvas);
      return reply(result.ok ? { dataUrl: result.dataUrl, width: result.width, height: result.height, mimeType: result.mimeType } : { error: result.error });
    }

    if (preferAssetImage) {
      const pick = findDominantPreviewImage();
      if (!pick) return reply({ error: 'No large preview image found. Open an image in the preview column first.' });
      const r = tryRasterizePreviewImage(pick.img);
      if (!r.ok) return reply({ error: r.error || 'Could not rasterize the opened image' });
      return reply({ dataUrl: r.dataUrl, width: r.width, height: r.height, mimeType: r.mimeType });
    }

    const pick = findDominantPreviewImage();
    if (pick && shouldOfferImageQuickAdd(pick)) {
      const r = tryRasterizePreviewImage(pick.img);
      if (r.ok) return reply({ dataUrl: r.dataUrl, width: r.width, height: r.height, mimeType: r.mimeType });
    }
    const canvas = document.querySelector('canvas');
    if (!canvas) return reply({ error: pick ? 'Image raster failed and no canvas found' : 'No canvas found' });
    const result = tryRasterizeCanvas(canvas);
    return reply(result.ok ? { dataUrl: result.dataUrl, width: result.width, height: result.height, mimeType: result.mimeType } : { error: result.error });
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
    try {
      if (typeof globalThis.__typstAgentImproveExtract === 'function') {
        const diagnostics = globalThis.__typstAgentImproveExtract(document);
        if (Array.isArray(diagnostics)) return diagnostics;
      }
    } catch {
      // Fall through to an explicit status row. A parser failure must never
      // become a false "clean" result.
    }
    return [{
      severity: 'warning',
      message: 'The Improve panel parser is unavailable. Reload the Typst tab and read diagnostics again.',
      line: null,
      column: null,
      kind: 'typst-status',
      original: null,
      suggestion: null
    }];
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

  function getProbe() {
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

    return {
      editor: hasEditor,
      selection: hasSelection,
      typstCanvas: hasTypstCanvas,
      previewImage: hasPreviewImage,
      improvePanel
    };
  }

  function getDiagnostics() {
    const view = findEditorView();
    if (!view) {
      return { diagnostics: [], error: 'EditorView not found' };
    }
    const lintRanges = strategyLintRanges(view);
    const improve = strategyImprovePanel();
    const results = mergeDiagnostics(lintRanges, improve);
    const diagnostics = [];
    let serializedChars = 0;
    for (const diagnostic of results) {
      if (diagnostics.length >= MAX_PAGE_DIAGNOSTICS) break;
      const bounded = {
        severity: String(diagnostic?.severity || 'info').slice(0, 16),
        message: String(diagnostic?.message || '').slice(0, 2_000),
        line: Number.isInteger(diagnostic?.line) && diagnostic.line >= 0 ? diagnostic.line : null,
        column: Number.isInteger(diagnostic?.column) && diagnostic.column >= 0 ? diagnostic.column : null,
        kind: String(diagnostic?.kind || 'typst').slice(0, 32),
        original: diagnostic?.original == null ? null : String(diagnostic.original).slice(0, 500),
        suggestion: diagnostic?.suggestion == null ? null : String(diagnostic.suggestion).slice(0, 500)
      };
      const length = JSON.stringify(bounded).length;
      if (serializedChars + length > MAX_PAGE_DIAGNOSTICS_CHARS - 1_000) break;
      serializedChars += length;
      diagnostics.push(bounded);
    }
    return {
      diagnostics,
      totalCount: results.length,
      truncated: diagnostics.length < results.length
    };
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
      postBridgeEvent(TYPES.PAGE_QUICK_SELECTION);
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
      postBridgeEvent(TYPES.PAGE_QUICK_IMAGE_PREVIEW);
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

  function startFloatController() {
    const factory = globalThis.__typstAgentCreateFloatController;
    if (typeof factory !== 'function' || globalThis.__typstAgentFloatController) return;
    globalThis.__typstAgentFloatController = factory({
      document,
      window,
      onFlush(flags) {
        if (flags.has('workspace')) workspaceCache = undefined;
        if (flags.has('workspace') || flags.has('preview')) dominantImageCache = undefined;
        if (flags.has('selection') || flags.has('layout')) updateSelectionFloatButton();
        if (flags.has('preview') || flags.has('workspace') || flags.has('layout')) updateImageFloatButton();
      }
    });
  }

  if (document.body) startFloatController();
  else document.addEventListener('DOMContentLoaded', startFloatController, { once: true });

  // ---------- Message bridge ----------

  function postBridgeEvent(type, payload = {}) {
    if (!activeBridgeNonce) return;
    window.postMessage(bridge.envelope(type, payload, {
      requestId: bridge.requestId('page-event'),
      nonce: activeBridgeNonce
    }), '*');
  }

  function postResponse(request, result, error) {
    let responseError = error;
    if (!responseError && !bridge.validResponseData(request.type, result)) {
      responseError = Object.assign(new Error(`${request.type} produced an invalid or oversized response.`), { code: 'INVALID_PAGE_RESPONSE' });
    }
    const payload = responseError
      ? { ok: false, error: { code: responseError.code || 'PAGE_REQUEST_FAILED', message: String(responseError.message || responseError).slice(0, 2_000) } }
      : { ok: true, data: result };
    window.postMessage(bridge.envelope(TYPES.RESPONSE, payload, {
      requestId: request.requestId,
      runId: request.runId,
      nonce: request.nonce
    }), '*');
  }

  function rememberBridgeNonce(nonce) {
    bridgeNonces.delete(nonce);
    bridgeNonces.add(nonce);
    while (bridgeNonces.size > MAX_BRIDGE_NONCES) bridgeNonces.delete(bridgeNonces.values().next().value);
    activeBridgeNonce = nonce;
  }

  function rememberCancelledPageRequest(requestId) {
    const previous = cancelledPageRequests.get(requestId);
    if (previous != null) clearTimeout(previous);
    const timer = setTimeout(() => cancelledPageRequests.delete(requestId), 12_000);
    cancelledPageRequests.set(requestId, timer);
  }

  function handleBridgeMessage(evt) {
    const request = evt.data;
    if (evt.source !== window || !bridge.valid(request)) return;
    if (request.type === TYPES.PAGE_BRIDGE_INIT) {
      if (typeof request.nonce !== 'string' || !request.nonce || typeof request.requestId !== 'string') return;
      rememberBridgeNonce(request.nonce);
      window.postMessage(bridge.envelope(TYPES.PAGE_BRIDGE_READY, {}, {
        requestId: request.requestId,
        nonce: request.nonce
      }), '*');
      return;
    }
    if (!bridgeNonces.has(request.nonce) || !bridge.PAGE_REQUESTS.has(request.type) || typeof request.requestId !== 'string') return;
    if (request.type === TYPES.PAGE_CANCEL_REQUEST) {
      rememberCancelledPageRequest(request.payload.targetRequestId);
      postResponse(request, { cancelled: true });
      return;
    }
    if (cancelledPageRequests.has(request.requestId)) {
      clearTimeout(cancelledPageRequests.get(request.requestId));
      cancelledPageRequests.delete(request.requestId);
      postResponse(request, null, Object.assign(new Error('Page request was cancelled before execution.'), { code: 'CANCELLED' }));
      return;
    }
    try {
      let result;
      switch (request.type) {
        case TYPES.PAGE_GET_CONTEXT: result = getContext(request.payload); break;
        case TYPES.PAGE_GET_DIAGNOSTICS: result = getDiagnostics(); break;
        case TYPES.PAGE_GET_PROBE: result = getProbe(); break;
        case TYPES.PAGE_GET_PREVIEW:
          result = capturePreview({
            preferTypstCanvas: !!request.payload.preferTypstCanvas,
            preferAssetImage: !!request.payload.preferAssetImage
          });
          break;
        case TYPES.PAGE_SHOW_EDIT_PREVIEW:
          result = { result: showPreparedEditPreview(request.runId, request.payload.expectedText, request.payload.expectedEditorToken, request.payload.expectedFileLabel, request.payload.changes, request.payload.callId, request.payload.preview) };
          break;
        case TYPES.PAGE_CLEAR_EDIT_PREVIEW:
          result = { result: clearPreparedEditPreview(request.runId, request.payload.callId) };
          break;
        case TYPES.PAGE_APPLY_EDIT:
          result = { result: applyPreparedEdit(request.runId, request.payload.callId, request.payload.expectedText, request.payload.expectedEditorToken, request.payload.expectedFileLabel, request.payload.changes) };
          if (result.result.ok) clearPreparedEditPreview(request.runId, request.payload.callId);
          break;
        default: return;
      }
      postResponse(request, result);
    } catch (error) {
      postResponse(request, null, error);
    }
  }

  window.addEventListener('message', handleBridgeMessage);

  const runtime = {
    version: RUNTIME_VERSION,
    dispose() {
      window.removeEventListener('message', handleBridgeMessage);
      window.removeEventListener('pagehide', handlePageHide);
      try { globalThis.__typstAgentFloatController?.stop?.(); } catch { /* page is unloading */ }
      clearPreparedEditPreview();
      for (const timer of cancelledPageRequests.values()) clearTimeout(timer);
      cancelledPageRequests.clear();
      delete globalThis.__typstAgentFloatController;
      document.getElementById(SEL_FLOAT_ID)?.remove();
      document.getElementById(IMG_FLOAT_ID)?.remove();
      bridgeNonces.clear();
      activeBridgeNonce = null;
      if (window.__typstAgentMainRuntime === runtime) delete window.__typstAgentMainRuntime;
      window.__typstAgentMainLoaded = false;
    }
  };
  function handlePageHide() { runtime.dispose(); }
  window.__typstAgentMainRuntime = runtime;
  window.addEventListener('pagehide', handlePageHide, { once: true });
})();
