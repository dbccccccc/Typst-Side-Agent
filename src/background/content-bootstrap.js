export const MAIN_CONTENT_SCRIPT_ID = 'typst-side-agent-main';
export const LEGACY_MAIN_CONTENT_SCRIPT_IDS = Object.freeze(['typst-agent-main']);
export const TYPST_MATCHES = Object.freeze(['https://typst.app/*']);

export const ISOLATED_WORLD_FILES = Object.freeze([
  'src/content/bridge-protocol.js',
  'src/content/isolated.js'
]);

export const MAIN_WORLD_FILES = Object.freeze([
  'src/content/bridge-protocol.js',
  'src/content/workspace.js',
  'src/content/diagnostics.js',
  'src/content/float-controller.js',
  'src/content/main.js'
]);

export function desiredMainContentScript() {
  return {
    id: MAIN_CONTENT_SCRIPT_ID,
    matches: [...TYPST_MATCHES],
    js: [...MAIN_WORLD_FILES],
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true
  };
}

/** Repair registrations that can survive an unpacked-extension reload. */
export async function ensureMainWorldRegistration(scripting) {
  const ids = [MAIN_CONTENT_SCRIPT_ID, ...LEGACY_MAIN_CONTENT_SCRIPT_IDS];
  const registered = await scripting.getRegisteredContentScripts({ ids });
  const legacy = registered.filter(script => LEGACY_MAIN_CONTENT_SCRIPT_IDS.includes(script.id));
  if (legacy.length) {
    await scripting.unregisterContentScripts({ ids: legacy.map(script => script.id) });
  }

  const current = registered.find(script => script.id === MAIN_CONTENT_SCRIPT_ID);
  const desired = desiredMainContentScript();
  if (!current) {
    await scripting.registerContentScripts([desired]);
    return { changed: true, action: 'registered' };
  }
  if (sameRegistration(current, desired)) {
    return { changed: legacy.length > 0, action: legacy.length ? 'removed-legacy' : 'unchanged' };
  }

  if (typeof scripting.updateContentScripts === 'function') {
    await scripting.updateContentScripts([desired]);
  } else {
    await scripting.unregisterContentScripts({ ids: [MAIN_CONTENT_SCRIPT_ID] });
    await scripting.registerContentScripts([desired]);
  }
  return { changed: true, action: 'updated' };
}

/** Idempotently repair already-open Typst tabs after install/update/reload. */
export async function injectIntoExistingTypstTabs(tabsApi, scripting) {
  const tabs = await tabsApi.query({ url: TYPST_MATCHES[0] });
  const results = [];
  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id)) continue;
    try {
      await scripting.executeScript({
        target: { tabId: tab.id },
        files: [...ISOLATED_WORLD_FILES]
      });
      await scripting.executeScript({
        target: { tabId: tab.id },
        files: [...MAIN_WORLD_FILES],
        world: 'MAIN'
      });
      results.push({ tabId: tab.id, ok: true });
    } catch (error) {
      results.push({ tabId: tab.id, ok: false, error: error?.message || String(error) });
    }
  }
  return results;
}

function sameRegistration(actual, desired) {
  return sameArray(actual.matches, desired.matches) &&
    sameArray(actual.js, desired.js) &&
    actual.runAt === desired.runAt &&
    actual.world === desired.world &&
    actual.persistAcrossSessions !== false;
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}
