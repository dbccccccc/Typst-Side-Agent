/** The Tools (custom HTTP) and MCP tabs. */
import { PROTOCOL } from '../../shared/protocol.js';
import { insecureAcknowledgementFields } from '../../shared/endpoint-policy.js';
import { validateToolSchema } from '../../shared/tool-validation.js';
import { customToolTrustFingerprint, mcpServerTrustFingerprint } from '../../shared/trust-policy.js';
import { state, bg } from '../state.js';
import { setStatus } from '../status-controller.js';
import {
  $, buildEntityRow, clearCheckboxWhenEdited, customRegistryController, mcpRegistryController,
  parseHeaders, runRegistryMutation, shortenUrl, validatedEndpoint
} from './settings-shared.js';

const DEFAULT_TOOL_PARAMETERS = '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}';
const SUPPORTED_MCP_MODES = ['auto', '2026-07-28'];

// ---------- Custom HTTP tools ----------

export function initCustomTools() {
  $('add-tool-btn').addEventListener('click', () => openToolForm());
  $('tool-cancel').addEventListener('click', () => closeToolForm());
  $('tool-save').addEventListener('click', () => saveToolForm());
  clearCheckboxWhenEdited(['tf-name', 'tf-desc', 'tf-endpoint', 'tf-headers', 'tf-params'], 'tf-trusted');
  clearCheckboxWhenEdited(['tf-endpoint'], 'tf-insecure');
}

export function renderCustomToolRegistry() {
  const root = $('tool-registry');
  root.innerHTML = '';
  for (const t of state.customTools) {
    root.appendChild(buildEntityRow({
      title: t.name,
      meta: `${shortenUrl(t.endpoint)}${t.description ? ' · ' + t.description : ''}`,
      enabled: t.enabled !== false,
      onToggle: () => runRegistryMutation(() => customRegistryController.toggle(t.id), renderCustomToolRegistry),
      onEdit: () => openToolForm(t),
      onDelete: () => runRegistryMutation(() => customRegistryController.remove(t.id), renderCustomToolRegistry)
    }));
  }
}

function openToolForm(tool = null) {
  $('tool-form').classList.remove('hidden');
  $('add-tool-btn').classList.add('hidden');
  $('tool-form-title').textContent = tool ? 'Edit custom tool' : 'Add custom tool';
  $('tool-form-id').value = tool?.id || '';
  $('tf-name').value = tool?.name || '';
  $('tf-desc').value = tool?.description || '';
  $('tf-endpoint').value = tool?.endpoint || '';
  $('tf-headers').value = tool?.headers ? JSON.stringify(tool.headers, null, 2) : '';
  $('tf-params').value = tool ? (tool.parameters ? JSON.stringify(tool.parameters, null, 2) : '') : DEFAULT_TOOL_PARAMETERS;
  $('tf-enabled').checked = tool ? tool.enabled !== false : true;
  $('tf-trusted').checked = !!tool?.trustedAutoRun;
  $('tf-insecure').checked = !!tool?.insecureTransportAcknowledged;
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
  const trustedAutoRun = $('tf-trusted').checked;
  const insecureTransportAcknowledged = $('tf-insecure').checked;

  let endpointCheck;
  let headers;
  try {
    endpointCheck = validatedEndpoint(endpoint, insecureTransportAcknowledged);
    headers = parseHeaders(headersText);
  } catch (error) { setStatus(error.message, true); return; }

  let parameters = { type: 'object', properties: {} };
  if (paramsText) {
    try { parameters = JSON.parse(paramsText); }
    catch { setStatus('Parameters must be valid JSON Schema.', true); return; }
  }
  const schema = validateToolSchema(parameters);
  if (!schema.ok) { setStatus(schema.error.message, true); return; }

  const editId = $('tool-form-id').value;
  const record = {
    id: editId || crypto.randomUUID(),
    name, description, endpoint: endpointCheck.url, headers, parameters, enabled, trustedAutoRun,
    ...insecureAcknowledgementFields(endpointCheck, insecureTransportAcknowledged)
  };
  record.trustedAutoRunFingerprint = trustedAutoRun ? customToolTrustFingerprint(record) : null;
  try { await customRegistryController.upsert(record); }
  catch (error) { setStatus(error.message, true); return; }
  closeToolForm();
  renderCustomToolRegistry();
  setStatus('Custom tool saved', false, 1500);
}

// ---------- MCP servers ----------

export function initMcpServers() {
  $('add-mcp-btn').addEventListener('click', () => openMcpForm());
  $('mcp-cancel').addEventListener('click', () => closeMcpForm());
  $('mcp-save').addEventListener('click', () => saveMcpForm());
  $('mcp-probe').addEventListener('click', () => probeMcpForm());
  clearCheckboxWhenEdited(['mcp-name', 'mcp-url', 'mcp-headers', 'mcp-protocol'], 'mcp-trusted');
  clearCheckboxWhenEdited(['mcp-url'], 'mcp-insecure');
}

export function renderMcpRegistry() {
  const root = $('mcp-registry');
  root.innerHTML = '';
  for (const s of state.mcpServers) {
    root.appendChild(buildEntityRow({
      title: s.name,
      meta: shortenUrl(s.url),
      enabled: s.enabled !== false,
      onToggle: () => runRegistryMutation(() => mcpRegistryController.toggle(s.id), renderMcpRegistry),
      onEdit: () => openMcpForm(s),
      onDelete: () => runRegistryMutation(() => mcpRegistryController.remove(s.id), renderMcpRegistry)
    }));
  }
}

function openMcpForm(server = null) {
  $('mcp-form').classList.remove('hidden');
  $('add-mcp-btn').classList.add('hidden');
  $('mcp-probe-result').classList.add('hidden');
  $('mcp-probe-result').textContent = '';
  $('mcp-form-title').textContent = server ? 'Edit MCP server' : 'Add MCP server';
  $('mcp-form-id').value = server?.id || '';
  $('mcp-name').value = server?.name || '';
  $('mcp-url').value = server?.url || '';
  $('mcp-headers').value = server?.headers ? JSON.stringify(server.headers, null, 2) : '';
  $('mcp-enabled').checked = server ? server.enabled !== false : true;
  $('mcp-protocol').value = server?.protocolMode || 'auto';
  $('mcp-trusted').checked = !!server?.trustedAutoRun;
  $('mcp-insecure').checked = !!server?.insecureTransportAcknowledged;
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
  const protocolMode = $('mcp-protocol').value || 'auto';
  const trustedAutoRun = $('mcp-trusted').checked;
  const insecureTransportAcknowledged = $('mcp-insecure').checked;
  if (!name) throw new Error('Name required');
  if (!SUPPORTED_MCP_MODES.includes(protocolMode)) throw new Error('Unsupported MCP protocol mode.');
  const endpoint = validatedEndpoint(url, insecureTransportAcknowledged);
  const headers = parseHeaders(headersText, { mcp: true });
  return {
    name, url: endpoint.url, headers, enabled, protocolMode, trustedAutoRun,
    ...insecureAcknowledgementFields(endpoint, insecureTransportAcknowledged)
  };
}

async function saveMcpForm() {
  let data;
  try { data = readMcpForm(); }
  catch (e) { setStatus(e.message, true); return; }
  const editId = $('mcp-form-id').value;
  const record = { id: editId || crypto.randomUUID(), ...data };
  record.trustedAutoRunFingerprint = record.trustedAutoRun ? mcpServerTrustFingerprint(record) : null;
  try { await mcpRegistryController.upsert(record); }
  catch (error) { setStatus(error.message, true); return; }
  closeMcpForm();
  renderMcpRegistry();
  setStatus('MCP server saved', false, 1500);
}

async function probeMcpForm() {
  const result = $('mcp-probe-result');
  result.classList.remove('hidden', 'ok', 'err');
  result.textContent = 'Probing…';
  let data;
  try { data = readMcpForm(); }
  catch (e) { result.classList.add('err'); result.textContent = e.message; return; }
  try {
    const r = await bg({ type: PROTOCOL.PROBE_MCP_SERVER, server: { id: $('mcp-form-id').value || 'probe', ...data } });
    result.classList.add('ok');
    const lines = [
      `Connected using MCP ${r.version}.`,
      `${r.tools.length} valid tool(s), ${r.errors?.length || 0} rejected schema(s), ${r.pages || 1} page(s).`,
      `Discovery cache: ${r.cache?.status || 'unknown'}; TTL ${r.ttlMs || 0} ms (${r.cacheScope || 'private'}).`
    ];
    if (r.tools.length) lines.push(...r.tools.map(tool => `  • ${tool.name}`));
    if (r.errors?.length) lines.push(...r.errors.slice(0, 5).map(error => `  ! ${error.name || 'tool'}: ${error.message}`));
    result.textContent = lines.join('\n');
  } catch (error) {
    result.classList.add('err');
    result.textContent = `Probe failed [${error.code || 'ERROR'}]: ${error.message}`;
  }
}
