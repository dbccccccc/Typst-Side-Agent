import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISOLATED_WORLD_FILES,
  MAIN_CONTENT_SCRIPT_ID,
  MAIN_WORLD_FILES,
  desiredMainContentScript,
  ensureMainWorldRegistration,
  injectIntoExistingTypstTabs
} from '../src/background/content-bootstrap.js';

test('stale persisted main-world registration is updated on worker bootstrap', async () => {
  const calls = [];
  const scripting = {
    async getRegisteredContentScripts() {
      return [
        { ...desiredMainContentScript(), js: MAIN_WORLD_FILES.slice(1) },
        { id: 'typst-agent-main', matches: ['https://typst.app/*'], js: ['src/content/main.js'], runAt: 'document_start', world: 'MAIN' }
      ];
    },
    async unregisterContentScripts(value) { calls.push(['unregister', value]); },
    async updateContentScripts(value) { calls.push(['update', value]); },
    async registerContentScripts(value) { calls.push(['register', value]); }
  };

  const result = await ensureMainWorldRegistration(scripting);
  assert.deepEqual(result, { changed: true, action: 'updated' });
  assert.deepEqual(calls[0], ['unregister', { ids: ['typst-agent-main'] }]);
  assert.equal(calls[1][0], 'update');
  assert.deepEqual(calls[1][1][0], desiredMainContentScript());
  assert.equal(calls.some(([name]) => name === 'register'), false);
});

test('missing registration is created and current registration is left stable', async () => {
  const registered = [];
  const scripting = {
    async getRegisteredContentScripts() { return registered; },
    async unregisterContentScripts() {},
    async registerContentScripts(scripts) { registered.push(...scripts); }
  };

  assert.deepEqual(await ensureMainWorldRegistration(scripting), { changed: true, action: 'registered' });
  assert.equal(registered[0].id, MAIN_CONTENT_SCRIPT_ID);
  assert.deepEqual(registered[0].js, MAIN_WORLD_FILES);
  assert.deepEqual(await ensureMainWorldRegistration(scripting), { changed: false, action: 'unchanged' });
});

test('open Typst tabs receive isolated and main bundles in dependency order', async () => {
  const calls = [];
  const tabs = { async query() { return [{ id: 7 }, { id: null }, { id: 9 }]; } };
  const scripting = {
    async executeScript(value) {
      calls.push(value);
      if (value.target.tabId === 9 && value.world === 'MAIN') throw new Error('closing tab');
    }
  };

  const results = await injectIntoExistingTypstTabs(tabs, scripting);
  assert.deepEqual(calls[0], { target: { tabId: 7 }, files: [...ISOLATED_WORLD_FILES] });
  assert.deepEqual(calls[1], { target: { tabId: 7 }, files: [...MAIN_WORLD_FILES], world: 'MAIN' });
  assert.equal(calls[0].files[0], 'src/content/bridge-protocol.js');
  assert.equal(calls[1].files[0], 'src/content/bridge-protocol.js');
  assert.deepEqual(results, [
    { tabId: 7, ok: true },
    { tabId: 9, ok: false, error: 'closing tab' }
  ]);
});
