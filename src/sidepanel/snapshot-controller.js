import { PROTOCOL } from '../shared/protocol.js';

const KIND_LABELS = Object.freeze({
  manual: 'Saved',
  automatic: 'Response',
  rescue: 'Recovery'
});

export function createSnapshotController({
  request,
  getScope,
  isLocked,
  setStatus,
  renderDiff,
  onRestored,
  onBeforeOpen = () => {}
}) {
  let open = false;
  let busy = false;
  let pendingRestore = null;
  let pendingDelete = null;
  let activeTrigger = null;
  let dialogTrigger = null;
  let initialized = false;

  const element = id => document.getElementById(id);

  function scopePayload(type, extra = {}) {
    const scope = getScope();
    if (!Number.isInteger(scope?.tabId) || !scope?.projectId || !scope?.sessionId) {
      throw new Error('Open a Typst project and chat first.');
    }
    return { type, tabId: scope.tabId, projectId: scope.projectId, sessionId: scope.sessionId, ...extra };
  }

  function setBusy(value) {
    busy = !!value;
    syncDisabledState();
  }

  function syncDisabledState() {
    const disabled = busy || isLocked();
    document.querySelectorAll('.response-snapshot-button').forEach(button => {
      button.disabled = disabled;
    });
    document.querySelectorAll('.snapshot-item-action').forEach(button => {
      button.disabled = disabled;
    });
  }

  function positionMenu() {
    const menu = element('snapshot-menu');
    const app = document.querySelector('.app');
    if (!open || !menu || !app || !activeTrigger?.isConnected) return;
    const appRect = app.getBoundingClientRect();
    const triggerRect = activeTrigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const margin = 8;
    const gap = 6;
    const left = Math.max(margin, Math.min(
      triggerRect.left - appRect.left,
      appRect.width - width - margin
    ));
    const above = triggerRect.top - appRect.top - height - gap;
    const below = triggerRect.bottom - appRect.top + gap;
    const top = above >= margin
      ? above
      : Math.min(below, Math.max(margin, appRect.height - height - margin));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function closeMenu({ focus = false } = {}) {
    const trigger = activeTrigger;
    open = false;
    activeTrigger = null;
    const menu = element('snapshot-menu');
    menu?.classList.add('hidden');
    menu?.style.removeProperty('left');
    menu?.style.removeProperty('top');
    trigger?.setAttribute('aria-expanded', 'false');
    if (focus && trigger?.isConnected) trigger.focus();
  }

  async function openFor(trigger) {
    if (!trigger?.isConnected || busy || isLocked()) return;
    if (open && activeTrigger === trigger) {
      closeMenu({ focus: true });
      return;
    }
    onBeforeOpen();
    closeMenu();
    activeTrigger = trigger;
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    element('snapshot-menu')?.classList.remove('hidden');
    renderLoading();
    positionMenu();
    await refresh();
    positionMenu();
  }

  function renderLoading() {
    const list = element('snapshot-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'snapshot-empty';
    row.textContent = 'Loading…';
    list.replaceChildren(row);
  }

  function renderEmpty(message = 'No response snapshot is available. It may have been cleared after the document changed.') {
    const list = element('snapshot-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'snapshot-empty';
    row.textContent = message;
    list.replaceChildren(row);
  }

  async function refresh() {
    if (!open) return;
    try {
      const result = await request(scopePayload(PROTOCOL.DOCUMENT_SNAPSHOT_LIST));
      if (!open) return;
      const snapshots = Array.isArray(result?.snapshots) ? result.snapshots : [];
      const file = element('snapshot-file');
      if (file) {
        file.textContent = result?.fileLabel || 'Current Typst document';
        file.title = file.textContent;
      }
      renderSnapshots(snapshots);
    } catch (error) {
      if (open) renderEmpty(error?.message || String(error));
    } finally {
      syncDisabledState();
    }
  }

  function renderSnapshots(snapshots) {
    const list = element('snapshot-list');
    if (!list) return;
    list.replaceChildren();
    if (!snapshots.length) {
      renderEmpty();
      return;
    }
    for (const snapshot of snapshots) list.appendChild(renderSnapshotItem(snapshot));
  }

  function renderSnapshotItem(snapshot) {
    const row = document.createElement('article');
    row.className = `snapshot-item is-${snapshot.kind || 'manual'}`;

    const marker = document.createElement('span');
    marker.className = 'snapshot-item-marker';
    marker.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('span');
    copy.className = 'snapshot-item-copy';
    const top = document.createElement('span');
    top.className = 'snapshot-item-topline';
    const title = document.createElement('strong');
    title.textContent = snapshot.title || 'Document snapshot';
    const badge = document.createElement('span');
    badge.className = `snapshot-kind is-${snapshot.kind || 'manual'}`;
    badge.textContent = KIND_LABELS[snapshot.kind] || 'Saved';
    top.append(title, badge);
    const meta = document.createElement('span');
    meta.className = 'snapshot-item-meta';
    meta.textContent = `${formatSnapshotDate(snapshot.createdAt)} · ${formatCharacterCount(snapshot.textLength)}`;
    copy.append(top, meta);

    const actions = document.createElement('span');
    actions.className = 'snapshot-item-actions';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'snapshot-item-action snapshot-restore-action';
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => previewRestore(snapshot));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'snapshot-item-action snapshot-delete-action';
    remove.title = 'Delete snapshot';
    remove.setAttribute('aria-label', `Delete ${snapshot.title || 'snapshot'}`);
    remove.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
    remove.addEventListener('click', () => {
      try { openDeleteDialog(snapshot); }
      catch (error) { setStatus(`Snapshot delete confirmation failed: ${error?.message || String(error)}`, true); }
    });
    actions.append(restore, remove);

    row.append(marker, copy, actions);
    return row;
  }

  async function previewRestore(snapshot) {
    if (busy || isLocked()) return;
    setBusy(true);
    setStatus('Preparing snapshot preview…');
    try {
      const previewRequest = scopePayload(PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW, { snapshotId: snapshot.id });
      const result = await request(previewRequest);
      pendingRestore = {
        ...result,
        requestScope: {
          tabId: previewRequest.tabId,
          projectId: previewRequest.projectId,
          sessionId: previewRequest.sessionId
        }
      };
      dialogTrigger = activeTrigger;
      closeMenu();
      renderRestoreDialog(result);
      setStatus('');
    } catch (error) {
      setStatus(`Snapshot preview failed: ${error?.message || String(error)}`, true);
    } finally {
      setBusy(false);
    }
  }

  function renderRestoreDialog(result) {
    const layer = element('snapshot-dialog-layer');
    const body = element('snapshot-dialog-body');
    const title = element('snapshot-dialog-title');
    const subtitle = element('snapshot-dialog-subtitle');
    const confirm = element('snapshot-dialog-confirm');
    if (!layer || !body || !title || !subtitle || !confirm) return;
    pendingDelete = null;
    layer.dataset.dialogMode = 'restore';
    title.textContent = result?.noChanges ? 'Already at this snapshot' : 'Restore this snapshot?';
    subtitle.textContent = `${result?.snapshot?.fileLabel || 'Current Typst document'} · ${formatSnapshotDate(result?.snapshot?.createdAt)}`;
    body.replaceChildren();
    if (result?.noChanges) {
      const note = document.createElement('div');
      note.className = 'snapshot-dialog-note is-success';
      note.textContent = 'The current document already matches this saved state.';
      body.appendChild(note);
    } else if (result?.preview) {
      body.appendChild(renderDiff(result.preview));
    } else {
      const note = document.createElement('div');
      note.className = 'snapshot-dialog-note is-warning';
      note.textContent = result?.previewNotice || 'A diff is unavailable. Restoring will replace the current document.';
      body.appendChild(note);
    }
    const safety = document.createElement('div');
    safety.className = 'snapshot-dialog-safety';
    safety.textContent = 'Your current document is saved as “Before restore” first.';
    body.appendChild(safety);
    confirm.disabled = !!result?.noChanges;
    confirm.textContent = result?.noChanges ? 'Already current' : 'Restore';
    confirm.classList.add('btn-primary');
    confirm.classList.remove('btn-danger');
    layer.classList.remove('hidden');
    confirm.focus();
  }

  function openDeleteDialog(snapshot) {
    if (busy || isLocked()) return;
    const deleteRequest = scopePayload(PROTOCOL.DOCUMENT_SNAPSHOT_DELETE, { snapshotId: snapshot.id });
    pendingDelete = {
      snapshot,
      requestScope: {
        tabId: deleteRequest.tabId,
        projectId: deleteRequest.projectId,
        sessionId: deleteRequest.sessionId
      }
    };
    dialogTrigger = activeTrigger;
    closeMenu();
    renderDeleteDialog(snapshot);
  }

  function renderDeleteDialog(snapshot) {
    const layer = element('snapshot-dialog-layer');
    const body = element('snapshot-dialog-body');
    const title = element('snapshot-dialog-title');
    const subtitle = element('snapshot-dialog-subtitle');
    const confirm = element('snapshot-dialog-confirm');
    if (!layer || !body || !title || !subtitle || !confirm) return;
    pendingRestore = null;
    layer.dataset.dialogMode = 'delete';
    title.textContent = 'Delete this snapshot?';
    subtitle.textContent = `${snapshot?.title || 'Document snapshot'} · ${snapshot?.fileLabel || 'Current Typst document'} · ${formatSnapshotDate(snapshot?.createdAt)}`;
    const warning = document.createElement('div');
    warning.className = 'snapshot-dialog-note is-danger';
    warning.textContent = 'This permanently removes the saved document copy. It cannot be restored after deletion.';
    body.replaceChildren(warning);
    confirm.disabled = false;
    confirm.textContent = 'Delete';
    confirm.classList.remove('btn-primary');
    confirm.classList.add('btn-danger');
    layer.classList.remove('hidden');
    confirm.focus();
  }

  function closeDialog({ focus = false } = {}) {
    pendingRestore = null;
    pendingDelete = null;
    element('snapshot-dialog-layer')?.classList.add('hidden');
    if (focus && dialogTrigger?.isConnected) dialogTrigger.focus();
    dialogTrigger = null;
  }

  async function confirmRestore() {
    const snapshotId = pendingRestore?.snapshot?.id;
    if (!snapshotId || pendingRestore?.noChanges || busy || isLocked()) return;
    const restoreScope = pendingRestore.requestScope;
    const currentScope = getScope();
    if (!restoreScope || currentScope?.tabId !== restoreScope.tabId || currentScope?.projectId !== restoreScope.projectId || currentScope?.sessionId !== restoreScope.sessionId) {
      closeDialog();
      setStatus('The active Typst project or chat changed. Open the snapshot again before restoring.', true);
      return;
    }
    setBusy(true);
    const confirm = element('snapshot-dialog-confirm');
    if (confirm) {
      confirm.disabled = true;
      confirm.textContent = 'Restoring…';
    }
    try {
      const result = await request({ type: PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE, ...restoreScope, snapshotId });
      let contextWarning = '';
      if (result?.editorStateUpdate) {
        try { await onRestored(result.editorStateUpdate, restoreScope); }
        catch (error) { contextWarning = error?.message || String(error); }
      }
      closeDialog();
      setStatus(contextWarning
        ? `Snapshot restored, but its chat context update was not saved: ${contextWarning}`
        : result?.noChanges ? 'The document already matched this snapshot' : 'Snapshot restored; the previous document was saved',
      !!contextWarning, contextWarning ? 0 : 2800);
    } catch (error) {
      setStatus(`Snapshot restore failed: ${error?.message || String(error)}`, true);
      if (confirm) {
        confirm.disabled = false;
        confirm.textContent = 'Restore';
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const snapshot = pendingDelete?.snapshot;
    const deleteScope = pendingDelete?.requestScope;
    if (!snapshot?.id || !deleteScope || busy || isLocked()) return;
    const currentScope = getScope();
    if (currentScope?.tabId !== deleteScope.tabId || currentScope?.projectId !== deleteScope.projectId || currentScope?.sessionId !== deleteScope.sessionId) {
      closeDialog();
      setStatus('The active Typst project or chat changed. Open the snapshot again before deleting it.', true);
      return;
    }
    setBusy(true);
    let reopenTrigger = null;
    const confirm = element('snapshot-dialog-confirm');
    if (confirm) {
      confirm.disabled = true;
      confirm.textContent = 'Deleting…';
    }
    try {
      await request({ type: PROTOCOL.DOCUMENT_SNAPSHOT_DELETE, ...deleteScope, snapshotId: snapshot.id });
      reopenTrigger = dialogTrigger;
      closeDialog();
      setStatus('Snapshot deleted', false, 1800);
    } catch (error) {
      setStatus(`Snapshot was not deleted: ${error?.message || String(error)}`, true);
      if (confirm) {
        confirm.disabled = false;
        confirm.textContent = 'Delete';
      }
    } finally {
      setBusy(false);
    }
    if (reopenTrigger?.isConnected && !isLocked()) await openFor(reopenTrigger);
  }

  function confirmDialogAction() {
    return pendingDelete ? confirmDelete() : confirmRestore();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    element('snapshot-menu-close')?.addEventListener('click', () => closeMenu({ focus: true }));
    element('snapshot-dialog-cancel')?.addEventListener('click', () => closeDialog({ focus: true }));
    element('snapshot-dialog-close')?.addEventListener('click', () => closeDialog({ focus: true }));
    element('snapshot-dialog-confirm')?.addEventListener('click', confirmDialogAction);
    element('snapshot-dialog-layer')?.addEventListener('click', event => {
      if (event.target === element('snapshot-dialog-layer') && !busy) closeDialog({ focus: true });
    });
    document.addEventListener('click', event => {
      const menu = element('snapshot-menu');
      if (open && menu && !menu.contains(event.target) && !activeTrigger?.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!element('snapshot-dialog-layer')?.classList.contains('hidden') && !busy) {
        event.preventDefault();
        closeDialog({ focus: true });
      } else if (open) {
        event.preventDefault();
        closeMenu({ focus: true });
      }
    });
    element('messages')?.addEventListener('scroll', () => closeMenu(), { passive: true });
    globalThis.addEventListener?.('resize', () => closeMenu());
    syncDisabledState();
  }

  function reset() {
    closeMenu();
    closeDialog();
    const file = element('snapshot-file');
    if (file) file.textContent = 'Current Typst document';
  }

  return {
    init,
    reset,
    openFor,
    closeMenu,
    refreshIfOpen: () => open ? refresh().then(positionMenu) : Promise.resolve(),
    setLocked: () => {
      syncDisabledState();
      if (isLocked()) closeMenu();
    }
  };
}

export function formatSnapshotDate(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return 'Saved recently';
  const delta = Math.max(0, now - value);
  if (delta < 60_000) return 'Just now';
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} hr ago`;
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatCharacterCount(value) {
  const count = Number.isInteger(value) && value >= 0 ? value : 0;
  return count < 1_000 ? `${count} chars` : `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k chars`;
}
