/** The Models tab and the header model selector. */
import { isReasoningEffortDefault } from '../../shared/constants.js';
import { insecureAcknowledgementFields } from '../../shared/endpoint-policy.js';
import { state, getActiveModel } from '../state.js';
import { setStatus } from '../status-controller.js';
import {
  $, clearCheckboxWhenEdited, iconButton, modelRegistryController, runRegistryMutation, shortenUrl, validatedEndpoint
} from './settings-shared.js';
import { renderAutoNameModelOptions } from './general-settings.js';

export function initModels(onModelsChanged) {
  $('add-model-btn').addEventListener('click', () => openModelForm());
  $('mf-cancel').addEventListener('click', () => closeModelForm());
  $('mf-save').addEventListener('click', () => saveModelForm(onModelsChanged));
  clearCheckboxWhenEdited(['mf-base-url'], 'mf-insecure');
}

function badge(className, text) {
  const element = document.createElement('span');
  element.className = `badge ${className}`;
  element.textContent = text;
  return element;
}

export function renderModelRegistry(onModelsChanged) {
  const root = $('model-registry');
  root.innerHTML = '';
  for (const m of state.settings.models) {
    const item = document.createElement('div');
    item.className = 'model-reg-item';

    const info = document.createElement('div');
    info.className = 'model-reg-info';
    const name = document.createElement('div');
    name.className = 'model-reg-name';
    name.textContent = m.name || m.modelId;
    const url = document.createElement('div');
    url.className = 'model-reg-url';
    url.textContent = shortenUrl(m.apiBaseUrl) + ' · ' + m.modelId;
    info.append(name, url);

    const badges = document.createElement('div');
    badges.className = 'model-reg-badges';
    if (m.supportsVision) badges.appendChild(badge('ok', 'vision'));
    if (m.reasoningEffort && !isReasoningEffortDefault(m.reasoningEffort)) badges.appendChild(badge('accent', m.reasoningEffort));

    const actions = document.createElement('div');
    actions.className = 'model-reg-actions';
    const editBtn = iconButton({ title: 'Edit', text: '✎' });
    editBtn.addEventListener('click', () => openModelForm(m));
    const delBtn = iconButton({ title: 'Delete', text: '×', className: 'delete-btn' });
    delBtn.addEventListener('click', () => runRegistryMutation(
      () => modelRegistryController.remove(m.id),
      () => {
        renderModelRegistry(onModelsChanged);
        renderAutoNameModelOptions();
        onModelsChanged?.();
      }
    ));
    actions.append(editBtn, delBtn);

    item.append(info, badges, actions);
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
    item.addEventListener('click', () => runRegistryMutation(
      () => modelRegistryController.select(m.id),
      () => {
        renderModelSelector(onSelected);
        $('model-menu').classList.add('hidden');
        onSelected?.();
      }
    ));
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
  $('model-form-title').textContent = model ? 'Edit model' : 'Add model';
  $('model-form-id').value = model?.id || '';
  $('mf-name').value = model?.name || '';
  $('mf-base-url').value = model?.apiBaseUrl || '';
  $('mf-insecure').checked = !!model?.insecureTransportAcknowledged;
  $('mf-api-key').value = model?.apiKey || '';
  $('mf-model-id').value = model?.modelId || '';
  $('mf-vision').checked = !!model?.supportsVision;
  $('mf-reasoning-effort').value = !model || isReasoningEffortDefault(model.reasoningEffort) ? 'default' : model.reasoningEffort;
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
  const insecureTransportAcknowledged = $('mf-insecure').checked;
  if (!name || !apiBaseUrl || !apiKey || !modelId) {
    setStatus('Fill all model fields', true);
    return;
  }
  let endpoint;
  try { endpoint = validatedEndpoint(apiBaseUrl, insecureTransportAcknowledged); }
  catch (error) { setStatus(error.message, true); return; }
  const consent = insecureAcknowledgementFields(endpoint, insecureTransportAcknowledged);
  const editId = $('model-form-id').value;
  const existing = editId ? state.settings.models.find(model => model.id === editId) : null;
  const record = {
    ...(existing || {}),
    id: editId || crypto.randomUUID(),
    name, apiBaseUrl: endpoint.url, apiKey, modelId, supportsVision, reasoningEffort, ...consent
  };
  if (!await runRegistryMutation(() => modelRegistryController.upsert(record))) return;
  closeModelForm();
  renderModelRegistry(onModelsChanged);
  renderModelSelector(onModelsChanged);
  renderAutoNameModelOptions();
  setStatus('Model saved', false, 1500);
  onModelsChanged?.();
}
