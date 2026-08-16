import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, collectPackageFiles, createArchive, listZipEntries, validatePackageInputs } from '../scripts/package-extension.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('canonical package includes user-facing docs/runtime and excludes development or sensitive paths', async () => {
  const names = (await collectPackageFiles(root)).map(file => file.archivePath);
  for (const required of ['manifest.json', 'README.md', 'ARCHITECTURE.md', 'PRIVACY.md', 'TESTING.md', 'LICENSE', 'src/sidepanel/index.html']) assert.ok(names.includes(required), required);
  assert.ok(!names.some(name => /^(?:test|plans|node_modules|\.git|\.github)\//.test(name)));
  assert.ok(!names.some(name => /\.(?:pem|key|crx|log)$/i.test(name)));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
});

test('manifest/package versions match and release tag mismatch fails before packaging', async () => {
  const files = await collectPackageFiles(root);
  const { version } = await validatePackageInputs(root, files, 'v1.0.1');
  assert.equal(version, '1.0.1');
  await assert.rejects(validatePackageInputs(root, files, 'v9.9.9'), /does not match/);
});

test('deterministic archive builds twice with stable ordered safe entries', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'typst-package-test-'));
  try {
    const onePath = resolve(temp, 'one.zip');
    const twoPath = resolve(temp, 'two.zip');
    const one = await createArchive({ root, output: onePath });
    const two = await createArchive({ root, output: twoPath });
    assert.equal(one.sha256, two.sha256);
    assert.deepEqual(await readFile(onePath), await readFile(twoPath));
    assert.deepEqual(listZipEntries(await readFile(onePath)), one.entries);
    assert.ok(one.entries.every(name => !name.includes('\\') && !name.startsWith('/') && !name.includes('../')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('ZIP builder rejects absolute, traversal, hidden, and sensitive paths', () => {
  for (const name of ['/absolute.js', '../escape.js', '.secret/key.txt', 'keys/client.pem', 'bad\\path.js']) {
    assert.throws(() => buildZip([{ name, data: Buffer.from('x') }]), /path|forbidden|Unsafe|Invalid/i, name);
  }
});
