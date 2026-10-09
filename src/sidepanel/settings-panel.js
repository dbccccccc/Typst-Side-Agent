/**
 * Settings panel facade. Each tab lives in ./settings/: general-settings.js
 * (tabs, General, theme), model-settings.js, integration-settings.js (custom
 * tools and MCP), and sessions-settings.js (the cross-project manager).
 */
export {
  applyTheme, initGeneralSettings, initSettingsTabs, initThemeSwitch, renderAutoNameModelOptions, renderGeneralSettings
} from './settings/general-settings.js';
export { initModels, renderModelRegistry, renderModelSelector } from './settings/model-settings.js';
export { initCustomTools, initMcpServers, renderCustomToolRegistry, renderMcpRegistry } from './settings/integration-settings.js';
export { initSessionsManager, openSessionsManagerPane, renderSessionsManager } from './settings/sessions-settings.js';
