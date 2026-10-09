/** Helpers and transactional controllers shared by the settings tabs. */
import { PROTOCOL } from '../../shared/protocol.js';
import { validateEndpointUrl, validateHeaderRecord } from '../../shared/endpoint-policy.js';
import { state, bg } from '../state.js';
import { createSessionController } from '../session-controller.js';
import { createModelRegistryController, createRecordRegistryController } from '../registry-controller.js';
import { setStatus } from '../status-controller.js';

export const $ = id => document.getElementById(id);

export const sessionManagementController = createSessionController({ request: bg });
export const modelRegistryController = createModelRegistryController({
  getSettings: () => state.settings,
  setSettings: settings => { state.settings = settings; },
  persist: (settings, modelMutation) => bg({ type: PROTOCOL.SAVE_SETTINGS, settings, modelMutation })
});
export const customRegistryController = createRecordRegistryController({
  getRecords: () => state.customTools,
  setRecords: tools => { state.customTools = tools; },
  persist: (tools, mutation) => bg({ type: PROTOCOL.SAVE_CUSTOM_TOOLS, tools, mutation })
});
export const mcpRegistryController = createRecordRegistryController({
  getRecords: () => state.mcpServers,
  setRecords: servers => { state.mcpServers = servers; },
  persist: (servers, mutation) => bg({ type: PROTOCOL.SAVE_MCP_SERVERS, servers, mutation })
});

export async function runRegistryMutation(action, onSuccess) {
  try {
    await action();
    onSuccess?.();
    return true;
  } catch (error) {
    setStatus(`Settings were not saved: ${error.message || String(error)}`, true);
    return false;
  }
}

export function shortenUrl(url) {
  try { return new URL(url).host; } catch { return url; }
}

export function validatedEndpoint(value, insecureConfirmed) {
  const checked = validateEndpointUrl(value, { insecureConfirmed });
  if (!checked.ok) throw Object.assign(new Error(checked.error.message), { code: checked.error.code });
  return checked;
}

/** Editing any identifying field withdraws a previously granted trust checkbox. */
export function clearCheckboxWhenEdited(fieldIds, checkboxId) {
  for (const id of fieldIds) {
    $(id).addEventListener('input', () => { $(checkboxId).checked = false; });
  }
}

export function parseHeaders(text, { mcp = false } = {}) {
  if (!text) return {};
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('Headers must be valid JSON.'); }
  const checked = validateHeaderRecord(value, { mcp });
  if (!checked.ok) throw new Error(checked.error.message);
  return value;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatRelative(ts) {
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

export function iconButton({ title, text, className = '' }) {
  const button = document.createElement('button');
  button.type = 'button';
  if (className) button.className = className;
  button.title = title;
  button.textContent = text;
  return button;
}

/** One registry row with an on/off badge and edit/delete actions. */
export function buildEntityRow({ title, meta, enabled, onToggle, onEdit, onDelete }) {
  const row = document.createElement('div');
  row.className = 'entity-row';

  const info = document.createElement('div');
  info.className = 'entity-info';
  const name = document.createElement('div');
  name.className = 'entity-name';
  name.textContent = title;
  info.appendChild(name);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'entity-meta';
    metaEl.textContent = meta;
    info.appendChild(metaEl);
  }

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
  const editBtn = iconButton({ title: 'Edit', text: '✎' });
  editBtn.addEventListener('click', onEdit);
  const delBtn = iconButton({ title: 'Delete', text: '×', className: 'delete-btn' });
  delBtn.addEventListener('click', onDelete);
  actions.append(editBtn, delBtn);

  row.append(info, badges, actions);
  return row;
}
