import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'verify';
if (!['verify', 'update'].includes(mode)) throw new Error('Usage: vendor-sidepanel-libs.mjs <verify|update>');

const artifacts = [
  {
    packageName: 'marked',
    version: '12.0.0',
    source: 'node_modules/marked/marked.min.js',
    destination: 'src/sidepanel/lib/marked.min.js',
    sha256: 'eb1f6b19880bc80a5fe34c6a61885173b60edda455ba7a33c98714db17d39f99'
  },
  {
    packageName: 'marked',
    version: '12.0.0',
    source: 'node_modules/marked/LICENSE.md',
    destination: 'src/sidepanel/lib/LICENSE.marked.md',
    sha256: '8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c'
  },
  {
    packageName: 'dompurify',
    version: '3.4.13',
    source: 'node_modules/dompurify/dist/purify.min.js',
    destination: 'src/sidepanel/lib/purify.min.js',
    sha256: '9ab3d44d73c3e3947f9ab72e0f0bc15c7f1931d60b365ba261fc85fe59013c56'
  },
  {
    packageName: 'dompurify',
    version: '3.4.13',
    source: 'node_modules/dompurify/dist/purify.min.js.map',
    destination: 'src/sidepanel/lib/purify.min.js.map',
    sha256: 'ef340d89dbe85999e57899ec63bfd1f53dee2d430843cdeb9680ccc6608225c3'
  },
  {
    packageName: 'dompurify',
    version: '3.4.13',
    source: 'node_modules/dompurify/LICENSE',
    destination: 'src/sidepanel/lib/LICENSE.dompurify-apache.txt',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
  },
  {
    packageName: 'dompurify',
    version: '3.4.13',
    source: 'node_modules/dompurify/LICENSE-MPL',
    destination: 'src/sidepanel/lib/LICENSE.dompurify-mpl.txt',
    sha256: 'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85'
  }
];

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

for (const artifact of artifacts) {
  const packageJson = JSON.parse(await readFile(resolve(root, `node_modules/${artifact.packageName}/package.json`), 'utf8'));
  if (packageJson.version !== artifact.version) {
    throw new Error(`${artifact.packageName}: expected ${artifact.version}, installed ${packageJson.version}`);
  }
  const source = await readFile(resolve(root, artifact.source));
  const sourceHash = digest(source);
  if (sourceHash !== artifact.sha256) {
    throw new Error(`${artifact.packageName}: package artifact checksum changed (${sourceHash})`);
  }
  const destination = resolve(root, artifact.destination);
  if (mode === 'update') {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  const committed = await readFile(destination).catch(() => null);
  if (!committed || digest(committed) !== artifact.sha256) {
    throw new Error(`${artifact.destination}: run npm run vendor:update and review the result`);
  }
  console.log(`${artifact.packageName}@${artifact.version}: ${artifact.sha256}`);
}
