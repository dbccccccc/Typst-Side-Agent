/**
 * Main-world event scheduler for quick-add affordances. Imported in tests for
 * its guarded global factory and injected before main.js in the extension.
 */
(function (root) {
  'use strict';
  if (root.__typstAgentCreateFloatController) return;

  root.__typstAgentCreateFloatController = function createFloatController(options) {
    const doc = options.document;
    const win = options.window;
    const raf = options.requestAnimationFrame || win.requestAnimationFrame.bind(win);
    const caf = options.cancelAnimationFrame || win.cancelAnimationFrame.bind(win);
    const setTimer = options.setTimeout || win.setTimeout.bind(win);
    const clearTimer = options.clearTimeout || win.clearTimeout.bind(win);
    const onFlush = options.onFlush;
    const dirty = new Set();
    const cleanups = [];
    let frame = null;
    let debounce = null;
    let stopped = false;

    function invalidate(...flags) {
      if (stopped) return;
      flags.forEach(flag => dirty.add(flag));
      if (doc.hidden) return;
      if (frame == null) frame = raf(flush);
    }

    function invalidateAfterBurst(...flags) {
      flags.forEach(flag => dirty.add(flag));
      if (debounce != null) clearTimer(debounce);
      debounce = setTimer(() => { debounce = null; invalidate(); }, 40);
    }

    function flush() {
      frame = null;
      if (stopped || doc.hidden || dirty.size === 0) return;
      const flags = new Set(dirty);
      dirty.clear();
      onFlush(flags);
    }

    function listen(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      cleanups.push(() => target.removeEventListener(type, handler, opts));
    }

    listen(doc, 'selectionchange', () => invalidate('selection', 'layout'));
    // Editor input changes selection/layout immediately. Preview/workspace
    // changes are observed at their DOM roots, avoiding a whole-page scan on
    // every typing burst.
    listen(doc, 'input', () => invalidateAfterBurst('selection', 'layout'));
    listen(doc, 'pointerup', () => invalidate('selection', 'layout'));
    listen(doc, 'keyup', () => invalidate('selection', 'layout'));
    listen(doc, 'visibilitychange', () => {
      if (doc.hidden) {
        if (frame != null) caf(frame);
        frame = null;
      } else invalidate('selection', 'preview', 'workspace', 'layout');
    });
    listen(win, 'resize', () => invalidate('layout'));
    listen(win, 'scroll', () => invalidate('layout'), true);
    listen(win, 'popstate', () => invalidateAfterBurst('preview', 'workspace', 'layout'));
    listen(win, 'hashchange', () => invalidateAfterBurst('preview', 'workspace', 'layout'));

    const Observer = options.MutationObserver || win.MutationObserver;
    const observers = [];
    if (Observer) {
      const FILES_SELECTOR = 'aside[aria-label*="Files" i], [role="region"][aria-label*="Files" i], [role="tree"]';
      const PREVIEW_SELECTOR = 'canvas, img, [data-typst-preview], [data-testid*="preview" i]';
      let surfaceObservers = [];

      const inEditor = node => !!node?.closest?.('.cm-editor');
      const filesRoot = () => {
        if (typeof options.filesRoot === 'function') return options.filesRoot();
        if (options.filesRoot) return options.filesRoot;
        return doc.querySelector(FILES_SELECTOR);
      };
      const previewRoots = () => {
        const configured = typeof options.previewRoots === 'function' ? options.previewRoots() : options.previewRoots;
        const candidates = configured
          ? Array.from(configured)
          : Array.from(doc.querySelectorAll?.(PREVIEW_SELECTOR) || []);
        return candidates.filter((node, index) =>
          node && candidates.indexOf(node) === index && !inEditor(node) && !node.closest?.(FILES_SELECTOR)
        );
      };
      const touchesSurface = node => {
        if (!node || inEditor(node)) return false;
        return !!node.matches?.(`${FILES_SELECTOR}, ${PREVIEW_SELECTOR}`)
          || !!node.querySelector?.(`${FILES_SELECTOR}, ${PREVIEW_SELECTOR}`);
      };

      function bindSurfaceObservers() {
        surfaceObservers.forEach(observer => observer.disconnect());
        surfaceObservers = [];
        const files = filesRoot();
        if (files && !inEditor(files)) {
          const filesObserver = new Observer(records => {
            if (records.some(record => !inEditor(record.target))) invalidateAfterBurst('workspace');
          });
          filesObserver.observe(files, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-selected', 'aria-expanded']
          });
          surfaceObservers.push(filesObserver);
        }
        const previews = previewRoots();
        if (previews.length) {
          const previewObserver = new Observer(records => {
            if (records.some(record => !inEditor(record.target))) invalidateAfterBurst('preview');
          });
          for (const preview of previews) {
            previewObserver.observe(preview, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['src', 'class', 'aria-selected']
            });
          }
          surfaceObservers.push(previewObserver);
        }
      }

      const shell = doc.body || doc.documentElement;
      if (shell) {
        const rootObserver = new Observer(records => {
          const surfaceChanged = records.some(record =>
            !inEditor(record.target)
            && [...(record.addedNodes || []), ...(record.removedNodes || [])].some(touchesSurface)
          );
          if (!surfaceChanged) return;
          bindSurfaceObservers();
          invalidateAfterBurst('preview', 'workspace', 'layout');
        });
        rootObserver.observe(shell, { childList: true, subtree: true });
        observers.push(rootObserver);
      }
      bindSurfaceObservers();
      observers.push({ disconnect() { surfaceObservers.forEach(observer => observer.disconnect()); } });
    }

    invalidate('selection', 'preview', 'workspace', 'layout');
    return {
      invalidate,
      flush,
      stop() {
        stopped = true;
        if (frame != null) caf(frame);
        if (debounce != null) clearTimer(debounce);
        observers.forEach(observer => observer.disconnect());
        cleanups.forEach(fn => fn());
        dirty.clear();
      },
      get dirtyFlags() { return new Set(dirty); }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
