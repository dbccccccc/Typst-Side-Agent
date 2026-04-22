/**
 * Settings panel: tabs, models, custom tools, MCP servers, sessions manager.
 */
import { isReasoningEffortDefault } from '../shared/constants.js';
import { state, bg, getActiveModel } from './state.js';

const $ = id => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $('status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function shortenUrl(url) {
  try { return new URL(url).host; } catch { return url; }
}

// =================================================================
// Tab switching
// =================================================================

export function initSettingsTabs() {
  const tabs = $('settings-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-tab');
    if (!btn) return;
    const target = btn.dataset.tab;
    tabs.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.settings-tab-pane').forEach(p => {
      p.classList.toggle('active', p.dataset.pane === target);
    });
    if (target === 'sessions') {
      renderSessionsManager().catch(() => {});
    }
  });
}

// =================================================================
// General settings
// =================================================================

export function initGeneralSettings(onSettingsChanged) {
  $('save-general-settings').addEventListener('click', async () => {
    state.settings.systemPrompt = $('system-prompt').value.trim();
    state.settings.maxHistoryMessages = Math.max(8, Math.min(200, Number($('history-cap').value) || 40));
    state.settings.autoNameModelId = $('auto-name-model').value || null;
    try {
      await bg({ type: 'SAVE_SETTINGS', settings: state.settings });
      setStatus('Settings saved');
      setTimeout(() => setStatus(''), 1500);
      onSettingsChanged?.();
    } catch (e) {
      setStatus(e.message, true);
    }
  });
}

export function renderGeneralSettings() {
  $('system-prompt').value = state.settings.systemPrompt || '';
  $('history-cap').value = state.settings.maxHistoryMessages || 40;
  renderAutoNameModelOptions();
}

/**
 * Refill the auto-name-model dropdown from the current model registry.
 * Should be called whenever models are added/removed.
 */
export function renderAutoNameModelOptions() {
  const sel = $('auto-name-model');
  if (!sel) return;
  const current = state.settings.autoNameModelId || '';
  sel.innerHTML = '';

  const off = document.createElement('option');
  off.value = '';
  off.textContent = 'Off (never auto-name)';
  sel.appendChild(off);

  for (const m of state.settings.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.modelId || 'Model';
    sel.appendChild(opt);
  }

  // Restore selection if the model still exists, otherwise fall back to Off.
  const hasCurrent = state.settings.models.some(m => m.id === current);
  sel.value = hasCurrent ? current : '';
  if (!hasCurrent && state.settings.autoNameModelId) {
    state.settings.autoNameModelId = null;
  }
}

// =================================================================
// Theme
// =================================================================

export function initThemeSwitch(onChange) {
  const sw = $('theme-switch');
  sw.addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg-opt');
    if (!btn?.dataset.theme) return;
    await applyAndSaveTheme(btn.dataset.theme, onChange);
  });
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('#theme-switch .seg-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

async function applyAndSaveTheme(theme, onChange) {
  applyTheme(theme);
  await bg({ type: 'SAVE_THEME', theme });
  onChange?.(theme);
}

// =================================================================
// Models
// =================================================================

export function initModels(onModelsChanged) {
  $('add-model-btn').addEventListener('click', () => openModelForm());
  $('mf-cancel').addEventListener('click', () => closeModelForm());
  $('mf-save').addEventListener('click', () => saveModelForm(onModelsChanged));
}

export function renderModelRegistry(onModelsChanged) {
  const root = $('model-registry');
  root.innerHTML = '';
  for (const m of state.settings.models) {
    const item = document.createElement('div');
    item.className = 'model-reg-item';

    const info = document.createElement('div');
    info.className = 'model-reg-info';
    info.innerHTML = `<div class="model-reg-name"></div><div class="model-reg-url"></div>`;
    info.querySelector('.model-reg-name').textContent = m.name || m.modelId;
    info.querySelector('.model-reg-url').textContent = shortenUrl(m.apiBaseUrl) + ' · ' + m.modelId;

    const badges = document.createElement('div');
    badges.className = 'model-reg-badges';
    if (m.supportsVision) {
      const b = document.createElement('span');
      b.className = 'badge ok';
      b.textContent = 'vision';
      badges.appendChild(b);
    }
    if (m.reasoningEffort && !isReasoningEffortDefault(m.reasoningEffort)) {
      const b = document.createElement('span');
      b.className = 'badge accent';
      b.textContent = m.reasoningEffort;
      badges.appendChild(b);
    }

    const actions = document.createElement('div');
    actions.className = 'model-reg-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '✎';
    editBtn.addEventListener('click', () => openModelForm(m));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'delete-btn';
    delBtn.title = 'Delete';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      state.settings.models = state.settings.models.filter(x => x.id !== m.id);
      if (state.settings.activeModelId === m.id) state.settings.activeModelId = state.settings.models[0]?.id || null;
      if (state.settings.autoNameModelId === m.id) state.settings.autoNameModelId = null;
      await bg({ type: 'SAVE_SETTINGS', settings: state.settings });
      renderModelRegistry(onModelsChanged);
      renderAutoNameModelOptions();
      onModelsChanged?.();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    item.appendChild(info);
    item.appendChild(badges);
    item.appendChild(actions);
    root.appendChild(item);
  }
}

export function renderModelSelector(onSelected) {
  const active = getActiveModel();
  $('model-name').textContent = active ? active.name : 'No model';
  const list = $('model-list');
  list.innerHTML = '';
  for (const m of state.settings.models) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dropdown-item' + (m.id === state.settings.activeModelId ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'dropdown-item-name';
    name.textContent = m.name;
    item.appendChild(name);
    if (m.supportsVision) {
      const v = document.createElement('span');
      v.className = 'vision-badge';
      v.textContent = 'V';
      item.appendChild(v);
    }
    item.addEventListener('click', async () => {
      state.settings.activeModelId = m.id;
      await bg({ type: 'SAVE_SETTINGS', settings: state.settings });
      renderModelSelector(onSelected);
      $('model-menu').classList.add('hidden');
      onSelected?.();
    });
    list.appendChild(item);
  }
  if (state.settings.models.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:10px;font-size:11px;color:var(--text-muted);text-align:center;';
    empty.textContent = 'Add a model in Settings → Models';
    list.appendChild(empty);
  }
}

function openModelForm(model = null) {
  $('model-form').classList.remove('hidden');
  $('add-model-btn').classList.add('hidden');
  if (model) {
    $('model-form-title').textContent = 'Edit model';
    $('model-form-id').value = model.id;
    $('mf-name').value = model.name || '';
    $('mf-base-url').value = model.apiBaseUrl || '';
    $('mf-api-key').value = model.apiKey || '';
    $('mf-model-id').value = model.modelId || '';
    $('mf-vision').checked = !!model.supportsVision;
    $('mf-reasoning-effort').value = isReasoningEffortDefault(model.reasoningEffort) ? 'default' : model.reasoningEffort;
  } else {
    $('model-form-title').textContent = 'Add model';
    $('model-form-id').value = '';
    $('mf-name').value = '';
    $('mf-base-url').value = '';
    $('mf-api-key').value = '';
    $('mf-model-id').value = '';
    $('mf-vision').checked = false;
    $('mf-reasoning-effort').value = 'default';
  }
}

function closeModelForm() {
  $('model-form').classList.add('hidden');
  $('add-model-btn').classList.remove('hidden');
}

async function saveModelForm(onModelsChanged) {
  const name = $('mf-name').value.trim();
  const apiBaseUrl = $('mf-base-url').value.trim();
  const apiKey = $('mf-api-key').value.trim();
  const modelId = $('mf-model-id').value.trim();
  const supportsVision = $('mf-vision').checked;
  const reasoningEffort = $('mf-reasoning-effort').value || 'default';
  if (!name || !apiBaseUrl || !apiKey || !modelId) {
    setStatus('Fill all model fields', true);
    return;
  }
  const editId = $('model-form-id').value;
  if (editId) {
    const idx = state.settings.models.findIndex(m => m.id === editId);
    if (idx !== -1) state.settings.models[idx] = { ...state.settings.models[idx], name, apiBaseUrl, apiKey, modelId, supportsVision, reasoningEffort };
  } else {
    const m = { id: crypto.randomUUID(), name, apiBaseUrl, apiKey, modelId, supportsVision, reasoningEffort };
    state.settings.models.push(m);
    if (!state.settings.activeModelId) state.settings.activeModelId = m.id;
  }
  await bg({ type: 'SAVE_SETTINGS', settings: state.settings });
  closeModelForm();
  renderModelRegistry(onModelsChanged);
  renderModelSelector(onModelsChanged);
  renderAutoNameModelOptions();
  setStatus('Model saved');
  setTimeout(() => setStatus(''), 1500);
  onModelsChanged?.();
}

// =================================================================
// Custom tools
// =================================================================

export function initCustomTools() {
  $('add-tool-btn').addEventListener('click', () => openToolForm());
  $('tool-cancel').addEventListener('click', () => closeToolForm());
  $('tool-save').addEventListener('click', () => saveToolForm());
}

export function renderCustomToolRegistry() {
  const root = $('tool-registry');
  root.innerHTML = '';
  for (const t of state.customTools) {
    root.appendChild(buildEntityRow({
      title: t.name,
      meta: `${shortenUrl(t.endpoint)}${t.description ? ' · ' + t.description : ''}`,
      enabled: t.enabled !== false,
      onToggle: async () => {
        t.enabled = !(t.enabled !== false);
        await bg({ type: 'SAVE_CUSTOM_TOOLS', tools: state.customTools });
        renderCustomToolRegistry();
      },
      onEdit: () => openToolForm(t),
      onDelete: async () => {
        state.customTools = state.customTools.filter(x => x.id !== t.id);
        await bg({ type: 'SAVE_CUSTOM_TOOLS', tools: state.customTools });
        renderCustomToolRegistry();
      }
    }));
  }
}

function openToolForm(tool = null) {
  $('tool-form').classList.remove('hidden');
  $('add-tool-btn').classList.add('hidden');
  if (tool) {
    $('tool-form-title').textContent = 'Edit custom tool';
    $('tool-form-id').value = tool.id;
    $('tf-name').value = tool.name || '';
    $('tf-desc').value = tool.description || '';
    $('tf-endpoint').value = tool.endpoint || '';
    $('tf-headers').value = tool.headers ? JSON.stringify(tool.headers, null, 2) : '';
    $('tf-params').value = tool.parameters ? JSON.stringify(tool.parameters, null, 2) : '';
    $('tf-enabled').checked = tool.enabled !== false;
  } else {
    $('tool-form-title').textContent = 'Add custom tool';
    $('tool-form-id').value = '';
    $('tf-name').value = '';
    $('tf-desc').value = '';
    $('tf-endpoint').value = '';
    $('tf-headers').value = '';
    $('tf-params').value = '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}';
    $('tf-enabled').checked = true;
  }
}

function closeToolForm() {
  $('tool-form').classList.add('hidden');
  $('add-tool-btn').classList.remove('hidden');
}

async function saveToolForm() {
  const name = $('tf-name').value.trim();
  const description = $('tf-desc').value.trim();
  const endpoint = $('tf-endpoint').value.trim();
  const headersText = $('tf-headers').value.trim();
  const paramsText = $('tf-params').value.trim();
  const enabled = $('tf-enabled').checked;

  if (!/^[a-z][a-z0-9_]{1,40}$/i.test(name)) {
    setStatus('Function name must be 2-41 chars: letters, digits, underscores.', true);
    return;
  }
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
    setStatus('Endpoint must be an http(s) URL.', true);
    return;
  }

  let headers = {};
  if (headersText) {
    try { headers = JSON.parse(headersText); }
    catch { setStatus('Headers must be valid JSON.', true); return; }
  }

  let parameters = { type: 'object', properties: {} };
  if (paramsText) {
    try { parameters = JSON.parse(paramsText); }
    catch { setStatus('Parameters must be valid JSON Schema.', true); return; }
  }

  const editId = $('tool-form-id').value;
  if (editId) {
    const idx = state.customTools.findIndex(t => t.id === editId);
    if (idx !== -1) state.customTools[idx] = { ...state.customTools[idx], name, description, endpoint, headers, parameters, enabled };
  } else {
    state.customTools.push({ id: crypto.randomUUID(), name, description, endpoint, headers, parameters, enabled });
  }
  await bg({ type: 'SAVE_CUSTOM_TOOLS', tools: state.customTools });
  closeToolForm();
  renderCustomToolRegistry();
  setStatus('Custom tool saved');
  setTimeout(() => setStatus(''), 1500);
}

// =================================================================
// MCP servers
// =================================================================

export function initMcpServers() {
  $('add-mcp-btn').addEventListener('click', () => openMcpForm());
  $('mcp-cancel').addEventListener('click', () => closeMcpForm());
  $('mcp-save').addEventListener('click', () => saveMcpForm());
  $('mcp-probe').addEventListener('click', () => probeMcpForm());
}

export function renderMcpRegistry() {
  const root = $('mcp-registry');
  root.innerHTML = '';
  for (const s of state.mcpServers) {
    root.appendChild(buildEntityRow({
      title: s.name,
      meta: shortenUrl(s.url),
      enabled: s.enabled !== false,
      onToggle: async () => {
        s.enabled = !(s.enabled !== false);
        await bg({ type: 'SAVE_MCP_SERVERS', servers: state.mcpServers });
        renderMcpRegistry();
      },
      onEdit: () => openMcpForm(s),
      onDelete: async () => {
        state.mcpServers = state.mcpServers.filter(x => x.id !== s.id);
        await bg({ type: 'SAVE_MCP_SERVERS', servers: state.mcpServers });
        renderMcpRegistry();
      }
    }));
  }
}

function openMcpForm(server = null) {
  $('mcp-form').classList.remove('hidden');
  $('add-mcp-btn').classList.add('hidden');
  $('mcp-probe-result').classList.add('hidden');
  $('mcp-probe-result').textContent = '';
  if (server) {
    $('mcp-form-title').textContent = 'Edit MCP server';
    $('mcp-form-id').value = server.id;
    $('mcp-name').value = server.name || '';
    $('mcp-url').value = server.url || '';
    $('mcp-headers').value = server.headers ? JSON.stringify(server.headers, null, 2) : '';
    $('mcp-enabled').checked = server.enabled !== false;
  } else {
    $('mcp-form-title').textContent = 'Add MCP server';
    $('mcp-form-id').value = '';
    $('mcp-name').value = '';
    $('mcp-url').value = '';
    $('mcp-headers').value = '';
    $('mcp-enabled').checked = true;
  }
}

function closeMcpForm() {
  $('mcp-form').classList.add('hidden');
  $('add-mcp-btn').classList.remove('hidden');
}

function readMcpForm() {
  const name = $('mcp-name').value.trim();
  const url = $('mcp-url').value.trim();
  const headersText = $('mcp-headers').value.trim();
  const enabled = $('mcp-enabled').checked;
  if (!name) throw new Error('Name required');
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('URL must be http(s)');
  let headers = {};
  if (headersText) {
    try { headers = JSON.parse(headersText); }
    catch { throw new Error('Headers must be valid JSON'); }
  }
  return { name, url, headers, enabled };
}

async function saveMcpForm() {
  let data;
  try { data = readMcpForm(); }
  catch (e) { setStatus(e.message, true); return; }
  const editId = $('mcp-form-id').value;
  if (editId) {
    const idx = state.mcpServers.findIndex(s => s.id === editId);
    if (idx !== -1) state.mcpServers[idx] = { ...state.mcpServers[idx], ...data };
  } else {
    state.mcpServers.push({ id: crypto.randomUUID(), ...data });
  }
  await bg({ type: 'SAVE_MCP_SERVERS', servers: state.mcpServers });
  closeMcpForm();
  renderMcpRegistry();
  setStatus('MCP server saved');
  setTimeout(() => setStatus(''), 1500);
}

async function probeMcpForm() {
  const result = $('mcp-probe-result');
  result.classList.remove('hidden', 'ok', 'err');
  result.textContent = 'Probing…';
  let data;
  try { data = readMcpForm(); }
  catch (e) { result.classList.add('err'); result.textContent = e.message; return; }
  const r = await bg({ type: 'PROBE_MCP_SERVER', server: data });
  if (r?.ok) {
    result.classList.add('ok');
    if (r.tools.length === 0) result.textContent = 'Connected. (Server returned 0 tools.)';
    else result.textContent = `Connected. ${r.tools.length} tool(s):\n` + r.tools.map(t => '  • ' + t.name).join('\n');
  } else {
    result.classList.add('err');
    result.textContent = 'Probe failed: ' + (r?.error || 'unknown error');
  }
}

// =================================================================
// Sessions manager (cross-project)
// =================================================================

/**
 * Live cache of the last fetched groups so the search filter can rerender
 * without hitting storage again on every keystroke.
 */
let sessionGroupsCache = [];
let sessionsSearchQuery = '';
let sessionsManagerHooks = null;

export function initSessionsManager(hooks = {}) {
  sessionsManagerHooks = hooks;
  $('sessions-refresh').addEventListener('click', () => {
    renderSessionsManager().catch(() => {});
  });
  $('sessions-export').addEventListener('click', () => exportSessions().catch(e => setStatus(e.message, true)));
  $('sessions-import').addEventListener('click', () => $('sessions-import-file').click());
  $('sessions-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await importSessions(file).catch(err => setStatus('Import failed: ' + err.message, true));
  });
  const search = $('sessions-search');
  search.addEventListener('input', () => {
    sessionsSearchQuery = search.value.trim().toLowerCase();
    renderSessionsManagerFromCache();
  });
}

/**
 * Force-fetch from the background and repaint the Sessions manager pane.
 * Safe to call even when the pane isn't visible; callers use it both to
 * prime the cache and to refresh after mutations.
 */
export async function renderSessionsManager() {
  const groups = await bg({ type: 'SESSION_LIST_ALL_GROUPED' });
  sessionGroupsCache = Array.isArray(groups) ? groups : [];
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
        .map(g => ({
          ...g,
          sessions: g.sessions.filter(s => sessionMatchesQuery(s, g.projectId, q))
        }))
        .filter(g => g.sessions.length > 0 || g.projectId.toLowerCase().includes(q))
    : sessionGroupsCache;

  const totalProjects = filtered.length;
  const totalSessions = filtered.reduce((n, g) => n + g.sessions.length, 0);
  const totalMessages = filtered.reduce(
    (n, g) => n + g.sessions.reduce((m, s) => m + (s.messages?.length || 0), 0),
    0
  );
  summary.textContent = totalProjects === 0
    ? (q ? 'No sessions match your filter.' : 'No chat sessions yet.')
    : `${totalProjects} project${totalProjects > 1 ? 's' : ''} · ${totalSessions} chat${totalSessions !== 1 ? 's' : ''} · ${totalMessages} message${totalMessages !== 1 ? 's' : ''}`;

  if (filtered.length === 0) return;

  for (const group of filtered) {
    root.appendChild(buildProjectCard(group));
  }
}

function sessionMatchesQuery(session, projectId, q) {
  if (!q) return true;
  if ((session.name || '').toLowerCase().includes(q)) return true;
  if (projectId.toLowerCase().includes(q)) return true;
  if (Array.isArray(session.messages)) {
    for (const m of session.messages) {
      if (typeof m?.content === 'string' && m.content.toLowerCase().includes(q)) return true;
    }
  }
  return false;
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
  const activeTag = state.currentProjectId && projectId === state.currentProjectId
    ? '<span class="badge ok" style="margin-right:6px;">current</span>' : '';
  meta.innerHTML = `${activeTag}${sessions.length} chat${sessions.length !== 1 ? 's' : ''} · ${totalMessages} msg · last ${formatRelative(lastActivity)}`;

  info.appendChild(title);
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'project-card-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-ghost btn-xs';
  openBtn.textContent = 'Open project';
  openBtn.title = 'Open this typst.app project in a new tab';
  openBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!projectId) return;
    await bg({ type: 'OPEN_PROJECT_TAB', projectId });
  });

  const delAllBtn = document.createElement('button');
  delAllBtn.type = 'button';
  delAllBtn.className = 'btn btn-ghost btn-xs danger';
  delAllBtn.textContent = 'Delete all';
  delAllBtn.title = 'Delete every chat in this project';
  delAllBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const msg = `Delete all ${sessions.length} chat${sessions.length !== 1 ? 's' : ''} from project "${projectId || '(blank)'}"? This cannot be undone.`;
    if (!confirm(msg)) return;
    await bg({ type: 'SESSION_DELETE_BY_PROJECT', projectId });
    await renderSessionsManager();
    sessionsManagerHooks?.onSessionsChanged?.();
    setStatus('Project sessions removed');
    setTimeout(() => setStatus(''), 1500);
  });

  if (projectId) actions.appendChild(openBtn);
  actions.appendChild(delAllBtn);

  header.appendChild(toggleCaret);
  header.appendChild(info);
  header.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'project-card-sessions';
  for (const s of sessions) list.appendChild(buildManagedSessionRow(s, projectId));

  header.addEventListener('click', () => {
    card.classList.toggle('collapsed');
  });

  card.appendChild(header);
  card.appendChild(list);
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
  const previewText = firstUserMessage(session) || '(no messages)';
  preview.textContent = previewText;
  preview.title = previewText;

  const meta = document.createElement('div');
  meta.className = 'managed-session-meta';
  const count = Array.isArray(session.messages) ? session.messages.length : 0;
  meta.textContent = `${count} msg · ${formatRelative(session.updatedAt)}`;

  main.appendChild(name);
  main.appendChild(preview);
  main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'managed-session-actions';

  const canSwitch = projectId && state.currentProjectId === projectId && state.currentSession?.id !== session.id;
  if (canSwitch) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.title = 'Switch to this chat';
    openBtn.textContent = '↗';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sessionsManagerHooks?.onSwitchToSession?.(session);
    });
    actions.appendChild(openBtn);
  }

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.title = 'Rename';
  renameBtn.innerHTML = '✎';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    beginManagedSessionRename(row, name, session);
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'delete-btn';
  delBtn.title = 'Delete chat';
  delBtn.textContent = '×';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${session.name || 'Untitled'}"?`)) return;
    await bg({ type: 'SESSION_DELETE', sessionId: session.id });
    await renderSessionsManager();
    sessionsManagerHooks?.onSessionsChanged?.(session);
    setStatus('Chat deleted');
    setTimeout(() => setStatus(''), 1200);
  });

  actions.appendChild(renameBtn);
  actions.appendChild(delBtn);

  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    beginManagedSessionRename(row, name, session);
  });

  row.appendChild(main);
  row.appendChild(actions);
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
  const finish = async (commit) => {
    if (done) return;
    done = true;
    row.classList.remove('renaming');
    const next = input.value.trim();
    if (commit && next && next !== original) {
      await bg({ type: 'SESSION_UPDATE', sessionId: session.id, name: next });
      await renderSessionsManager();
      sessionsManagerHooks?.onSessionsChanged?.({ ...session, name: next });
    } else {
      await renderSessionsManager();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function firstUserMessage(session) {
  if (!Array.isArray(session.messages)) return '';
  for (const m of session.messages) {
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }
  return '';
}

function formatRelative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function exportSessions() {
  const groups = await bg({ type: 'SESSION_LIST_ALL_GROUPED' });
  const flat = [];
  for (const g of (Array.isArray(groups) ? groups : [])) {
    for (const s of g.sessions) flat.push(s);
  }
  if (flat.length === 0) {
    setStatus('Nothing to export', true);
    setTimeout(() => setStatus(''), 1600);
    return;
  }
  const payload = {
    format: 'typst-side-agent-sessions',
    version: 1,
    exportedAt: Date.now(),
    sessions: flat
  };
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
  setStatus(`Exported ${flat.length} chat${flat.length !== 1 ? 's' : ''}`);
  setTimeout(() => setStatus(''), 1800);
}

async function importSessions(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('File is not valid JSON'); }
  const records = Array.isArray(parsed) ? parsed
                : Array.isArray(parsed?.sessions) ? parsed.sessions
                : null;
  if (!records) throw new Error('Unrecognised session export format');
  const r = await bg({ type: 'SESSION_IMPORT', records });
  if (!r?.ok) throw new Error(r?.error || 'Import rejected');
  await renderSessionsManager();
  sessionsManagerHooks?.onSessionsChanged?.();
  setStatus(`Imported ${r.imported} chat${r.imported !== 1 ? 's' : ''}`);
  setTimeout(() => setStatus(''), 2000);
}

/**
 * Open the settings panel directly on the Sessions tab, pre-populated.
 * Called from the "Manage all chats" entry in the session dropdown.
 */
export async function openSessionsManagerPane() {
  const panel = $('settings-panel');
  panel.classList.remove('collapsed');
  $('settings-toggle').classList.add('active');
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'sessions'));
  document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'sessions'));
  $('sessions-search').value = '';
  sessionsSearchQuery = '';
  await renderSessionsManager();
}

// =================================================================
// Reusable entity row
// =================================================================

function buildEntityRow({ title, meta, enabled, onToggle, onEdit, onDelete }) {
  const row = document.createElement('div');
  row.className = 'entity-row';

  const info = document.createElement('div');
  info.className = 'entity-info';
  const name = document.createElement('div');
  name.className = 'entity-name';
  name.textContent = title;
  const metaEl = document.createElement('div');
  metaEl.className = 'entity-meta';
  metaEl.textContent = meta || '';
  info.appendChild(name);
  if (meta) info.appendChild(metaEl);

  const badges = document.createElement('div');
  badges.className = 'entity-badges';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (enabled ? 'ok' : 'off');
  badge.textContent = enabled ? 'on' : 'off';
  badge.style.cursor = 'pointer';
  badge.title = enabled ? 'Click to disable' : 'Click to enable';
  badge.addEventListener('click', onToggle);
  badges.appendChild(badge);

  const actions = document.createElement('div');
  actions.className = 'entity-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.title = 'Edit';
  editBtn.innerHTML = '✎';
  editBtn.addEventListener('click', onEdit);
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'delete-btn';
  delBtn.title = 'Delete';
  delBtn.textContent = '×';
  delBtn.addEventListener('click', onDelete);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  row.appendChild(info);
  row.appendChild(badges);
  row.appendChild(actions);
  return row;
}
