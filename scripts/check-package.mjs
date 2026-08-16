import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_NAME, collectPackageFiles, createArchive, listZipEntries } from './package-extension.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = resolve(root, ARCHIVE_NAME);
const archive = await readFile(archivePath);
const actualEntries = listZipEntries(archive);
const expectedEntries = (await collectPackageFiles(root)).map(file => file.archivePath);
if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) throw new Error('Archive contents or ordering do not match the canonical package set.');

const temporary = await mkdtemp(resolve(tmpdir(), 'typst-side-agent-package-'));
try {
  const secondPath = resolve(temporary, ARCHIVE_NAME);
  await createArchive({ root, output: secondPath, expectedTag: process.env.RELEASE_TAG || null });
  const second = await readFile(secondPath);
  const firstHash = createHash('sha256').update(archive).digest('hex');
  const secondHash = createHash('sha256').update(second).digest('hex');
  if (firstHash !== secondHash) throw new Error(`Package is not deterministic: ${firstHash} != ${secondHash}`);
  console.log(`Verified ${actualEntries.length} entries, ${archive.length} bytes, sha256 ${firstHash}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
