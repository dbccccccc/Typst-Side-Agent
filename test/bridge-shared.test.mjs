import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  BRIDGE_FILE, SHARED_SOURCES, renderSharedRuntimeBlock, replaceSharedRuntimeBlock
} from '../scripts/sync-bridge-shared.mjs';
import * as activeFile from '../src/shared/active-file.js';
import { PAGE_LIMITS } from '../src/shared/page-limits.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(resolve(root, BRIDGE_FILE), 'utf8');

function loadBridgeShared() {
  const context = vm.createContext({ crypto: { randomUUID: () => 'uuid' }, Date, Math });
  vm.runInContext(bridgeSource, context, { filename: 'bridge-protocol.js' });
  return context.__typstAgentShared;
}

test('the committed bridge adapter embeds the current generated copy of the shared leaves', async () => {
  const block = await renderSharedRuntimeBlock(root);
  assert.equal(replaceSharedRuntimeBlock(bridgeSource, block), bridgeSource, 'run `npm run sync:bridge`');
  for (const file of SHARED_SOURCES) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, `${file} must stay dependency-free`);
  }
});

test('the page runtime and the worker agree on path normalization, labels, and limits', () => {
  const shared = loadBridgeShared();
  assert.ok(shared?.hash);
  // The bridge copy lives in another realm, so compare structure rather than prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(shared.PAGE_LIMITS)), JSON.parse(JSON.stringify(PAGE_LIMITS)));
  assert.equal(shared.DEFAULT_EDIT_FILE_LABEL, activeFile.DEFAULT_EDIT_FILE_LABEL);
  const samples = [
    'main.typ', './chapters//intro.typ', ' refs / ref.bib ', 'images\\logo.png', '/leading.typ', '../escape.typ',
    'no-extension', 'http://evil/x.typ', `${'a'.repeat(250)}.typ`, 'bad\nname.typ', null, 42
  ];
  for (const sample of samples) {
    assert.equal(shared.normalizeProjectRelativePath(sample), activeFile.normalizeProjectRelativePath(sample), String(sample));
    assert.equal(shared.isProjectFileBasename(sample), activeFile.isProjectFileBasename(sample), String(sample));
  }
  const workspaces = [
    null,
    { focused_element_file_hint: 'main.typ' },
    { detail_path: 'images/logo.png' },
    { active_editor_file: { relativePath: 'chapters/intro.typ', source: 'header_breadcrumb', confidence: 'high' } },
    { workspace: { active_editor_file: { relativePath: 'nested/file.typ' } } },
    { active_editor_file: { relativePath: 'invalid' }, focused_element_file_hint: 'fallback.typ' }
  ];
  for (const workspace of workspaces) {
    assert.equal(shared.editorFileLabel(workspace), activeFile.editorFileLabel(workspace), JSON.stringify(workspace));
  }
});

test('re-injecting the bridge reuses an identical shared runtime instead of redefining it', () => {
  const context = vm.createContext({ crypto: { randomUUID: () => 'uuid' }, Date, Math });
  vm.runInContext(bridgeSource, context, { filename: 'bridge-protocol.js' });
  const first = context.__typstAgentShared;
  vm.runInContext(bridgeSource, context, { filename: 'bridge-protocol-again.js' });
  assert.equal(context.__typstAgentShared, first);
  assert.ok(Object.isFrozen(first));
});
