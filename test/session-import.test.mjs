import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/shared/constants.js';
import { readSessionImportFile } from '../src/sidepanel/session-import.js';

test('session import parser accepts supported array and versioned exports', async () => {
  const array = [{ id: 'a', messages: [] }];
  assert.deepEqual(await readSessionImportFile({ size: 2, text: async () => JSON.stringify(array) }), array);
  const versioned = { version: 2, sessions: array };
  assert.deepEqual(await readSessionImportFile({ size: 2, text: async () => JSON.stringify(versioned) }), versioned);
});

test('session import parser rejects files and record collections before dispatch', async () => {
  let read = false;
  await assert.rejects(readSessionImportFile({
    size: LIMITS.MAX_SESSION_IMPORT_FILE_BYTES + 1,
    text: async () => { read = true; return '[]'; }
  }), /import limit/);
  assert.equal(read, false);
  const tooMany = Array.from({ length: LIMITS.MAX_SESSION_IMPORT_RECORDS + 1 }, () => ({}));
  await assert.rejects(readSessionImportFile({ size: 1, text: async () => JSON.stringify(tooMany) }), /chat limit/);
  await assert.rejects(readSessionImportFile({ size: 1, text: async () => '{' }), /valid JSON/);
});
