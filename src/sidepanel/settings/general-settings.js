/** Settings tabs, the General tab, and the theme switch. */
import { normalizeSendMessageShortcut } from '../../shared/constants.js';
import { PROTOCOL } from '../../shared/protocol.js';
import { state, bg } from '../state.js';
import { setStatus } from '../status-controller.js';
import { $ } from './settings-shared.js';
import { renderSessionsManager } from './sessions-settings.js';

export function initSettingsTabs() {
  const tabs = $('settings-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', event => {
    const btn = event.target.closest('.settings-tab');
    if (!btn) return;
    const target = btn.dataset.tab;
    tabs.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.settings-tab-pane').forEach(p => {
      p.classList.toggle('active', p.dataset.pane === target);
    });
    if (target === 'sessions') renderSessionsManager().catch(() => {});
  });
}

export function initGeneralSettings(onSettingsChanged) {
  $('save-general-settings').addEventListener('click', async () => {
    const next = {
      ...state.settings,
      systemPrompt: $('system-prompt').value.trim(),
      maxHistoryMessages: Math.max(8, Math.min(200, Number($('history-cap').value) || 40)),
      autoNameModelId: $('auto-name-model').value || null,
      sendMessageShortcut: normalizeSendMessageShortcut($('send-message-shortcut').value)
    };
    try {
      const saved = await bg({
        type: PROTOCOL.SAVE_SETTINGS,
        settings: next,
        fields: ['systemPrompt', 'maxHistoryMessages', 'autoNameModelId', 'sendMessageShortcut']
      });
      state.settings = saved?.settings || next;
      renderGeneralSettings();
      setStatus('Settings saved', false, 1500);
      onSettingsChanged?.();
    } catch (e) {
      setStatus(e.message, true);
    }
  });
}

export function renderGeneralSettings() {
  $('system-prompt').value = state.settings.systemPrompt || '';
  $('history-cap').value = state.settings.maxHistoryMessages || 40;
  $('send-message-shortcut').value = normalizeSendMessageShortcut(state.settings.sendMessageShortcut);
  renderAutoNameModelOptions();
}

/** Refill the auto-name-model dropdown from the current model registry. */
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
  if (!hasCurrent && state.settings.autoNameModelId) state.settings.autoNameModelId = null;
}

export function initThemeSwitch(onChange) {
  $('theme-switch').addEventListener('click', async event => {
    const btn = event.target.closest('.seg-opt');
    if (!btn?.dataset.theme) return;
    applyTheme(btn.dataset.theme);
    await bg({ type: PROTOCOL.SAVE_THEME, theme: btn.dataset.theme });
    onChange?.(btn.dataset.theme);
  });
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('#theme-switch .seg-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}
