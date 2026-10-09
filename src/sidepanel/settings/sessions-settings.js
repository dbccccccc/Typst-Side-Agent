/** The cross-project Sessions manager: search, open, rename, delete, export, import. */
import { state } from '../state.js';
import { setStatus } from '../status-controller.js';
import { readSessionImportFile } from '../session-import.js';
import { $, formatBytes, formatRelative, iconButton, sessionManagementController } from './settings-shared.js';

/** Last fetched groups so the search filter can rerender without hitting storage. */
let sessionGroupsCache = [];
let sessionsSearchQuery = '';
let sessionsManagerHooks = null;

export function initSessionsManager(hooks = {}) {
  sessionsManagerHooks = hooks;
  $('sessions-refresh').addEventListener('click', () => { renderSessionsManager().catch(() => {}); });
  $('sessions-export').addEventListener('click', () => exportSessions().catch(e => setStatus(e.message, true)));
  $('sessions-import').addEventListener('click', () => $('sessions-import-file').click());
  $('sessions-import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importSessions(file).catch(err => setStatus('Import failed: ' + err.message, true));
  });
  const search = $('sessions-search');
  search.addEventListener('input', () => {
    sessionsSearchQuery = search.value.trim().toLowerCase();
    renderSessionsManagerFromCache();
  });
}

/** Fetch from the worker and repaint; safe to call while the pane is hidden. */
export async function renderSessionsManager() {
  const [groups, storageStatus] = await Promise.all([
    sessionManagementController.listGrouped(),
    sessionManagementController.storageStatus()
  ]);
  sessionGroupsCache = Array.isArray(groups) ? groups : [];
  const storageEl = $('sessions-storage-status');
  if (storageEl) {
    const used = Number(storageStatus?.bytes || 0);
    const threshold = Number(storageStatus?.warningThreshold || 0);
    const warning = storageStatus?.warning ? ` — above the ${formatBytes(threshold)} warning threshold` : '';
    storageEl.textContent = `Stored chat data: ${formatBytes(used)}${warning}`;
    storageEl.classList.toggle('storage-warning', !!storageStatus?.warning);
  }
  renderSessionsManagerFromCache();
}

function renderSessionsManagerFromCache() {
  const root = $('sessions-projects');
  const summary = $('sessions-summary');
  root.innerHTML = '';
  summary.innerHTML = '';

  const q = sessionsSearchQuery;
  const filtered = q
    ? sessionGroupsCache
        .map(g => ({ ...g, sessions: g.sessions.filter(s => sessionMatchesQuery(s, g.projectId, q)) }))
        .filter(g => g.sessions.length > 0 || g.projectId.toLowerCase().includes(q))
    : sessionGroupsCache;

  const totalProjects = filtered.length;
  const totalSessions = filtered.reduce((n, g) => n + g.sessions.length, 0);
  const totalMessages = filtered.reduce((n, g) => n + g.sessions.reduce((m, s) => m + (s.messageCount || 0), 0), 0);
  summary.textContent = totalProjects === 0
    ? (q ? 'No sessions match your filter.' : 'No chat sessions yet.')
    : `${totalProjects} project${totalProjects > 1 ? 's' : ''} · ${plural(totalSessions, 'chat')} · ${plural(totalMessages, 'message')}`;

  for (const group of filtered) root.appendChild(buildProjectCard(group));
}

function plural(count, noun) {
  return `${count} ${noun}${count !== 1 ? 's' : ''}`;
}

function sessionMatchesQuery(session, projectId, q) {
  if (!q) return true;
  if ((session.name || '').toLowerCase().includes(q)) return true;
  if (projectId.toLowerCase().includes(q)) return true;
  return typeof session.searchText === 'string' && session.searchText.includes(q);
}

async function afterMutation(status, context) {
  await renderSessionsManager();
  sessionsManagerHooks?.onSessionsChanged?.(context);
  if (status) setStatus(status.text, false, status.duration);
}

function buildProjectCard(group) {
  const { projectId, sessions, lastActivity, totalMessages } = group;
  const card = document.createElement('div');
  card.className = 'project-card';

  const header = document.createElement('div');
  header.className = 'project-card-header';
  const toggleCaret = document.createElement('span');
  toggleCaret.className = 'project-card-caret';
  toggleCaret.textContent = '▾';
  const info = document.createElement('div');
  info.className = 'project-card-info';

  const title = document.createElement('div');
  title.className = 'project-card-title';
  title.textContent = projectId || '(no project id)';
  title.title = projectId || '';

  const meta = document.createElement('div');
  meta.className = 'project-card-meta';
  if (state.currentProjectId && projectId === state.currentProjectId) {
    const current = document.createElement('span');
    current.className = 'badge ok';
    current.style.marginRight = '6px';
    current.textContent = 'current';
    meta.appendChild(current);
  }
  meta.appendChild(document.createTextNode(`${plural(sessions.length, 'chat')} · ${totalMessages} msg · last ${formatRelative(lastActivity)}`));
  info.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'project-card-actions';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-ghost btn-xs';
  openBtn.textContent = 'Open project';
  openBtn.title = 'Open this typst.app project in a new tab';
  openBtn.addEventListener('click', async event => {
    event.stopPropagation();
    if (!projectId) return;
    await sessionManagementController.openProject(projectId);
  });
  const delAllBtn = document.createElement('button');
  delAllBtn.type = 'button';
  delAllBtn.className = 'btn btn-ghost btn-xs danger';
  delAllBtn.textContent = 'Delete all';
  delAllBtn.title = 'Delete every chat in this project';
  delAllBtn.addEventListener('click', async event => {
    event.stopPropagation();
    const message = `Delete all ${plural(sessions.length, 'chat')} from project "${projectId || '(blank)'}"? This cannot be undone.`;
    if (!confirm(message)) return;
    await sessionManagementController.removeProject(projectId);
    await afterMutation({ text: 'Project sessions removed', duration: 1500 });
  });
  if (projectId) actions.appendChild(openBtn);
  actions.appendChild(delAllBtn);

  header.append(toggleCaret, info, actions);
  header.addEventListener('click', () => card.classList.toggle('collapsed'));

  const list = document.createElement('div');
  list.className = 'project-card-sessions';
  for (const s of sessions) list.appendChild(buildManagedSessionRow(s, projectId));

  card.append(header, list);
  return card;
}

function buildManagedSessionRow(session, projectId) {
  const row = document.createElement('div');
  row.className = 'managed-session-row';
  if (state.currentSession?.id === session.id) row.classList.add('is-active');

  const main = document.createElement('div');
  main.className = 'managed-session-main';
  const name = document.createElement('div');
  name.className = 'managed-session-name';
  name.textContent = session.name || 'Untitled';
  name.title = 'Double-click to rename';
  const preview = document.createElement('div');
  preview.className = 'managed-session-preview';
  const previewText = session.preview || '(no messages)';
  preview.textContent = previewText;
  preview.title = previewText;
  const meta = document.createElement('div');
  meta.className = 'managed-session-meta';
  const count = Number.isInteger(session.messageCount) ? session.messageCount : 0;
  meta.textContent = `${count} msg · ${formatRelative(session.updatedAt)}`;
  main.append(name, preview, meta);

  const actions = document.createElement('div');
  actions.className = 'managed-session-actions';
  const canSwitch = projectId && state.currentProjectId === projectId && state.currentSession?.id !== session.id;
  if (canSwitch) {
    const openBtn = iconButton({ title: 'Switch to this chat', text: '↗' });
    openBtn.addEventListener('click', event => {
      event.stopPropagation();
      Promise.resolve(sessionsManagerHooks?.onSwitchToSession?.(session))
        .catch(error => setStatus(error.message || String(error), true));
    });
    actions.appendChild(openBtn);
  }
  const renameBtn = iconButton({ title: 'Rename', text: '✎' });
  renameBtn.addEventListener('click', event => {
    event.stopPropagation();
    beginManagedSessionRename(row, name, session);
  });
  const delBtn = iconButton({ title: 'Delete chat', text: '×', className: 'delete-btn' });
  delBtn.addEventListener('click', async event => {
    event.stopPropagation();
    if (!confirm(`Delete "${session.name || 'Untitled'}"?`)) return;
    await sessionManagementController.remove(session.id);
    await afterMutation({ text: 'Chat deleted', duration: 1200 }, session);
  });
  actions.append(renameBtn, delBtn);

  name.addEventListener('dblclick', event => {
    event.stopPropagation();
    beginManagedSessionRename(row, name, session);
  });

  row.append(main, actions);
  return row;
}

function beginManagedSessionRename(row, nameEl, session) {
  if (row.classList.contains('renaming')) return;
  row.classList.add('renaming');
  const original = session.name || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.maxLength = 80;
  input.className = 'managed-session-rename-input';
  input.setAttribute('spellcheck', 'false');
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async commit => {
    if (done) return;
    done = true;
    row.classList.remove('renaming');
    const next = input.value.trim();
    if (commit && next && next !== original) {
      await sessionManagementController.update(session.id, { name: next, userRenamed: true });
      await afterMutation(null, { ...session, name: next });
    } else {
      await renderSessionsManager();
    }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', event => event.stopPropagation());
}

async function exportSessions() {
  const payload = await sessionManagementController.exportAll();
  if (!Array.isArray(payload?.sessions) || payload.sessions.length === 0) {
    setStatus('Nothing to export', true, 1600);
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `typst-side-agent-sessions-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  setStatus(`Exported ${plural(payload.sessions.length, 'chat')}`, false, 1800);
}

async function importSessions(file) {
  const exportData = await readSessionImportFile(file);
  const r = await sessionManagementController.importAll(exportData);
  const rejected = r.rejected ? `; rejected ${r.rejected} invalid record${r.rejected === 1 ? '' : 's'}` : '';
  await afterMutation({ text: `Imported ${plural(r.imported, 'chat')}${rejected}`, duration: 2000 });
}

/** Open the settings panel directly on the Sessions tab. */
export async function openSessionsManagerPane() {
  $('settings-panel').classList.remove('collapsed');
  $('settings-toggle').classList.add('active');
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'sessions'));
  document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'sessions'));
  $('sessions-search').value = '';
  sessionsSearchQuery = '';
  await renderSessionsManager();
}
