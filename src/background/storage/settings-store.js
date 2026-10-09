/** Settings and theme persistence with fail-closed normalization. */
import { STORAGE_KEYS, normalizeEditorApprovalMode, normalizeSendMessageShortcut } from '../../shared/constants.js';
import { normalizeInsecureAcknowledgement, validateEndpointUrl } from '../../shared/endpoint-policy.js';
import { codedError } from '../../shared/errors.js';
import { enqueueMutation, isRecordId, readKey, writeKey } from './storage-core.js';

const DEFAULT_SETTINGS = Object.freeze({
  systemPrompt: '',
  models: [],
  activeModelId: null,
  maxHistoryMessages: 40,
  autoNameModelId: null,
  editorApprovalMode: 'ask',
  sendMessageShortcut: 'enter'
});

const SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));

export async function loadSettings() {
  const raw = await readKey(STORAGE_KEYS.SETTINGS, null);
  const settings = raw && typeof raw === 'object' ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
  if (!Array.isArray(settings.models)) settings.models = [];
  settings.models = settings.models.map(model => normalizeInsecureAcknowledgement(model, 'apiBaseUrl'));
  if (!settings.activeModelId && settings.models.length) settings.activeModelId = settings.models[0].id;
  if (!Number.isFinite(settings.maxHistoryMessages)) settings.maxHistoryMessages = DEFAULT_SETTINGS.maxHistoryMessages;
  settings.editorApprovalMode = normalizeEditorApprovalMode(settings.editorApprovalMode);
  settings.sendMessageShortcut = normalizeSendMessageShortcut(settings.sendMessageShortcut);
  return settings;
}

function applyModelMutation(settings, mutation) {
  if (!mutation) return settings;
  const models = Array.isArray(settings.models) ? settings.models.map(model => ({ ...model })) : [];
  if (mutation.type === 'upsert') {
    const record = { ...mutation.record };
    const position = models.findIndex(model => model.id === record.id);
    if (position >= 0) models[position] = { ...models[position], ...record };
    else models.push(record);
  } else if (mutation.type === 'remove') {
    const position = models.findIndex(model => model.id === mutation.id);
    if (position >= 0) models.splice(position, 1);
  } else if (mutation.type === 'replace') {
    models.splice(0, models.length, ...mutation.records.map(model => ({ ...model })));
  } else if (mutation.type === 'select') {
    if (!models.some(model => model.id === mutation.id)) throw codedError('UNKNOWN_MODEL', 'Unknown model.');
    return { ...settings, models, activeModelId: mutation.id };
  } else {
    throw codedError('INVALID_MODEL_MUTATION', 'Unsupported model mutation.');
  }
  return {
    ...settings,
    models,
    activeModelId: models.some(model => model.id === settings.activeModelId) ? settings.activeModelId : models[0]?.id || null,
    autoNameModelId: models.some(model => model.id === settings.autoNameModelId) ? settings.autoNameModelId : null
  };
}

function validateSettingsCandidate(settings) {
  const safe = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  safe.editorApprovalMode = normalizeEditorApprovalMode(safe.editorApprovalMode);
  safe.sendMessageShortcut = normalizeSendMessageShortcut(safe.sendMessageShortcut);
  if (!Array.isArray(safe.models)) throw codedError('INVALID_SETTINGS', 'models must be an array');
  safe.models = safe.models.map(model => normalizeInsecureAcknowledgement(model, 'apiBaseUrl'));
  const ids = new Set();
  for (const model of safe.models) {
    if (!model || typeof model !== 'object' || !isRecordId(model.id)) {
      throw codedError('INVALID_MODEL_ID', 'Every model requires a valid id.');
    }
    if (ids.has(model.id)) throw codedError('DUPLICATE_MODEL_ID', 'Model ids must be unique.');
    ids.add(model.id);
    const endpoint = validateEndpointUrl(model.apiBaseUrl, { insecureConfirmedOrigin: model.insecureTransportAcknowledgedOrigin });
    if (!endpoint.ok) throw codedError(endpoint.error.code, endpoint.error.message, endpoint.error.details);
  }
  if (!ids.has(safe.activeModelId)) safe.activeModelId = safe.models[0]?.id || null;
  if (!ids.has(safe.autoNameModelId)) safe.autoNameModelId = null;
  return safe;
}

export async function saveSettings(settings, options = {}) {
  return enqueueMutation(async () => {
    let candidate;
    const fields = Array.isArray(options.fields) ? options.fields.filter(field => SETTINGS_FIELDS.has(field)) : null;
    if (fields || options.modelMutation) {
      candidate = await loadSettings();
      for (const field of fields || []) {
        if (Object.prototype.hasOwnProperty.call(settings || {}, field)) candidate[field] = settings[field];
      }
      candidate = applyModelMutation(candidate, options.modelMutation);
    } else {
      candidate = settings;
    }
    const safe = validateSettingsCandidate(candidate);
    await writeKey(STORAGE_KEYS.SETTINGS, safe);
    return { ok: true, settings: safe };
  });
}

export async function loadTheme() {
  return readKey(STORAGE_KEYS.THEME, 'dark');
}

export async function saveTheme(theme) {
  await writeKey(STORAGE_KEYS.THEME, theme === 'light' ? 'light' : 'dark');
  return { ok: true };
}
