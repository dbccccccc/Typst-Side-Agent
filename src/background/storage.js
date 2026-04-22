import { STORAGE_KEYS } from '../shared/constants.js';

async function readKey(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

async function writeKey(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ---------- Settings ----------

const DEFAULT_SETTINGS = {
  systemPrompt: '',
  models: [],
  activeModelId: null,
  /** Cap conversation messages forwarded to the API (older messages summarised away). */
  maxHistoryMessages: 40,
  /** Optional id of a configured model used to auto-name new chat sessions. */
  autoNameModelId: null
};

export async function loadSettings() {
  let s = await readKey(STORAGE_KEYS.SETTINGS, null);
  if (!s) s = { ...DEFAULT_SETTINGS };

  if (!Array.isArray(s.models)) s.models = [];
  if (!s.activeModelId && s.models.length > 0) s.activeModelId = s.models[0].id;
  if (typeof s.maxHistoryMessages !== 'number') s.maxHistoryMessages = DEFAULT_SETTINGS.maxHistoryMessages;
  if (typeof s.autoNameModelId === 'undefined') s.autoNameModelId = DEFAULT_SETTINGS.autoNameModelId;

  return s;
}

export async function saveSettings(settings) {
  await writeKey(STORAGE_KEYS.SETTINGS, settings);
  return { ok: true };
}

// ---------- Sessions ----------

export async function loadSessions() {
  return await readKey(STORAGE_KEYS.SESSIONS, []);
}

async function saveSessions(sessions) {
  await writeKey(STORAGE_KEYS.SESSIONS, sessions);
}

export async function sessionList(projectId) {
  const all = await loadSessions();
  return all
    .filter(s => s.projectId === projectId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function sessionCreate(projectId, name) {
  const all = await loadSessions();
  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    projectId: String(projectId || ''),
    name: name || 'New chat',
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  all.push(session);
  await saveSessions(all);
  return session;
}

export async function sessionGet(sessionId) {
  const all = await loadSessions();
  return all.find(s => s.id === sessionId) || null;
}

export async function sessionUpdate(sessionId, updates) {
  const all = await loadSessions();
  const idx = all.findIndex(s => s.id === sessionId);
  if (idx === -1) return null;
  const next = { ...all[idx] };
  if ('name' in updates) next.name = updates.name;
  if ('messages' in updates) next.messages = updates.messages;
  next.updatedAt = Date.now();
  all[idx] = next;
  await saveSessions(all);
  return next;
}

export async function sessionDelete(sessionId) {
  const all = await loadSessions();
  await saveSessions(all.filter(s => s.id !== sessionId));
  return { ok: true };
}

/**
 * Return every session grouped by projectId, most recently active project first.
 * Each group carries aggregate counters so the manage panel doesn't have to
 * recompute them. Sessions inside a group are already sorted newest-first.
 */
export async function sessionListAllGrouped() {
  const all = await loadSessions();
  const groups = new Map();
  for (const s of all) {
    const key = s.projectId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const result = [];
  for (const [projectId, sessions] of groups) {
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const lastActivity = sessions.reduce((m, s) => Math.max(m, s.updatedAt || 0), 0);
    const totalMessages = sessions.reduce((n, s) => n + (Array.isArray(s.messages) ? s.messages.length : 0), 0);
    result.push({ projectId, sessions, lastActivity, totalMessages });
  }
  result.sort((a, b) => b.lastActivity - a.lastActivity);
  return result;
}

/** Delete every session that belongs to a given project. */
export async function sessionDeleteByProject(projectId) {
  const all = await loadSessions();
  const kept = all.filter(s => s.projectId !== projectId);
  await saveSessions(kept);
  return { ok: true, removed: all.length - kept.length };
}

/**
 * Merge an array of imported session records into storage.
 * Incoming ids collide → regenerate new ones; fields we don't control are
 * dropped. Returns how many records were imported.
 */
export async function sessionImport(records) {
  if (!Array.isArray(records) || records.length === 0) return { ok: true, imported: 0 };
  const all = await loadSessions();
  const existingIds = new Set(all.map(s => s.id));
  const now = Date.now();
  let imported = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const id = (rec.id && !existingIds.has(rec.id)) ? rec.id : crypto.randomUUID();
    existingIds.add(id);
    all.push({
      id,
      projectId: String(rec.projectId || ''),
      name: typeof rec.name === 'string' ? rec.name : 'Imported chat',
      messages: Array.isArray(rec.messages) ? rec.messages : [],
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : now
    });
    imported += 1;
  }
  await saveSessions(all);
  return { ok: true, imported };
}

// ---------- Custom Tools ----------

/**
 * A custom tool is a JSON-schema-backed function call that the agent can invoke.
 * On invocation, the extension POSTs `{ tool, args }` to `endpoint`. The server
 * is expected to reply with a JSON object that becomes the tool result.
 *
 * @typedef {Object} CustomTool
 * @property {string} id
 * @property {string} name        - Function name surfaced to the model.
 * @property {string} description - One sentence used by the model to choose it.
 * @property {Object} parameters  - JSON schema for the function arguments.
 * @property {string} endpoint    - HTTPS URL the extension POSTs to.
 * @property {Object<string,string>} [headers] - Extra HTTP headers (e.g. auth).
 * @property {boolean} enabled
 */

export async function loadCustomTools() {
  return await readKey(STORAGE_KEYS.CUSTOM_TOOLS, []);
}

export async function saveCustomTools(tools) {
  await writeKey(STORAGE_KEYS.CUSTOM_TOOLS, tools);
  return { ok: true };
}

// ---------- MCP Servers ----------

/**
 * Streamable-HTTP MCP server config.
 *
 * @typedef {Object} McpServer
 * @property {string} id
 * @property {string} name
 * @property {string} url        - Streamable-HTTP MCP endpoint.
 * @property {Object<string,string>} [headers]
 * @property {boolean} enabled
 */

export async function loadMcpServers() {
  return await readKey(STORAGE_KEYS.MCP_SERVERS, []);
}

export async function saveMcpServers(servers) {
  await writeKey(STORAGE_KEYS.MCP_SERVERS, servers);
  return { ok: true };
}

// ---------- Theme ----------

export async function loadTheme() {
  return await readKey(STORAGE_KEYS.THEME, 'dark');
}

export async function saveTheme(theme) {
  await writeKey(STORAGE_KEYS.THEME, theme);
  return { ok: true };
}
