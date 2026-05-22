/**
 * Cross-platform `node --check` over shipped sources (mirrors test/static.test.mjs).
 */
import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listShippedJs } from './list-shipped-js.mjs';

const execFile = promisify(execFileCb);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const files = await listShippedJs(REPO_ROOT);

if (files.length === 0) {
  console.error('check-syntax: no JS files found under src/');
  process.exit(1);
}

const failed = [];
await Promise.all(
  files.map(async rel => {
    const abs = path.join(REPO_ROOT, rel);
    try {
      await execFile(process.execPath, ['--check', abs]);
    } catch (e) {
      failed.push({ rel, err: (e.stderr || e.message || '').toString().trim().split('\n').slice(0, 3).join(' | ') });
    }
  })
);

if (failed.length > 0) {
  console.error('Syntax check failed:', JSON.stringify(failed, null, 2));
  process.exit(1);
}
