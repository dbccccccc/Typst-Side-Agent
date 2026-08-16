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
      const shell = doc.body || doc.documentElement;
      if (shell) {
        const rootObserver = new Observer(() => invalidateAfterBurst('preview', 'workspace', 'layout'));
        rootObserver.observe(shell, { childList: true });
        observers.push(rootObserver);
      }
      const previewRoot = options.previewRoot || doc.querySelector('main, [role="main"]');
      if (previewRoot) {
        const previewObserver = new Observer(() => invalidateAfterBurst('preview', 'workspace'));
        previewObserver.observe(previewRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'aria-selected'] });
        observers.push(previewObserver);
      }
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
