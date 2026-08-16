import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, collectPackageFiles, createArchive, listZipEntries, validatePackageInputs } from '../scripts/package-extension.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

test('canonical package includes linked public docs, license texts, and runtime while excluding development or sensitive paths', async () => {
  const names = (await collectPackageFiles(root)).map(file => file.archivePath);
  for (const required of [
    'manifest.json', 'README.md', 'ARCHITECTURE.md', 'PRIVACY.md', 'TESTING.md',
    'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'ROADMAP.md',
    'THIRD_PARTY_NOTICES.md', 'LICENSE', 'src/sidepanel/index.html',
    'src/sidepanel/lib/LICENSE.marked.md',
    'src/sidepanel/lib/LICENSE.dompurify-apache.txt',
    'src/sidepanel/lib/LICENSE.dompurify-mpl.txt'
  ]) assert.ok(names.includes(required), required);
  assert.ok(!names.some(name => /^(?:test|plans|node_modules|\.git|\.github)\//.test(name)));
  assert.ok(!names.some(name => /\.(?:pem|key|crx|log)$/i.test(name)));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
});

test('manifest/package versions match and release tag mismatch fails before packaging', async () => {
  const files = await collectPackageFiles(root);
  const { version } = await validatePackageInputs(root, files, `v${packageMetadata.version}`);
  assert.equal(version, packageMetadata.version);
  const parts = packageMetadata.version.split('.').map(Number);
  const differentTag = `v${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  await assert.rejects(validatePackageInputs(root, files, differentTag), /does not match/);
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
