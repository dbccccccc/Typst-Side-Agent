// List shipped extension JS under src/ (Node 20+). Skips lib/ and *.min.js.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function listShippedJs(repoRoot = REPO_ROOT) {
  const srcRoot = path.join(repoRoot, 'src');
  const out = [];

  async function walk(dir) {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === 'lib') continue;
        await walk(full);
      } else if (
        dirent.isFile() &&
        dirent.name.endsWith('.js') &&
        !dirent.name.endsWith('.min.js')
      ) {
        out.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
      }
    }
  }

  await walk(srcRoot);
  return out.sort();
}
