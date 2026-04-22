import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFile = promisify(execFileCb);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------- manifest.json validation ----------

test('manifest.json is valid JSON with required MV3 fields', async () => {
  const text = await readFile(new URL('../manifest.json', import.meta.url), 'utf8');
  const m = JSON.parse(text);

  assert.equal(m.manifest_version, 3);
  assert.ok(typeof m.name === 'string' && m.name.length > 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version), 'semver-ish version');
  assert.equal(m.background?.type, 'module');
  assert.ok(m.background?.service_worker, 'has service worker');
  assert.ok(m.side_panel?.default_path, 'declares side panel');
});

test('manifest.json: every web_accessible_resource file really exists', async () => {
  const text = await readFile(new URL('../manifest.json', import.meta.url), 'utf8');
  const m = JSON.parse(text);
  const files = (m.web_accessible_resources || []).flatMap(r => r.resources || []);
  for (const rel of files) {
    const stat = await readFile(new URL('../' + rel, import.meta.url), 'utf8').catch(() => null);
    assert.ok(stat != null, `missing asset: ${rel}`);
  }
});

test('manifest.json: service_worker and content_scripts point at real files', async () => {
  const text = await readFile(new URL('../manifest.json', import.meta.url), 'utf8');
  const m = JSON.parse(text);
  const paths = [m.background.service_worker];
  for (const cs of m.content_scripts || []) {
    paths.push(...(cs.js || []));
  }
  for (const rel of paths) {
    const txt = await readFile(new URL('../' + rel, import.meta.url), 'utf8').catch(() => null);
    assert.ok(txt != null, `missing script: ${rel}`);
  }
});

// ---------- Syntax check on every shipped JS module ----------

async function listShippedJs() {
  const out = [];
  for await (const entry of glob('src/**/*.js', { cwd: REPO_ROOT })) {
    const rel = entry.replace(/\\/g, '/');
    // Skip vendored / minified third-party bundles.
    if (rel.includes('/lib/') || rel.endsWith('.min.js')) continue;
    out.push(rel);
  }
  return out;
}

test('every src/**/*.js file parses cleanly', async () => {
  const files = await listShippedJs();
  assert.ok(files.length > 0, 'found at least one source file');

  const failed = [];
  await Promise.all(files.map(async rel => {
    const abs = path.join(REPO_ROOT, rel);
    try {
      await execFile(process.execPath, ['--check', abs]);
    } catch (e) {
      failed.push({ rel, err: (e.stderr || e.message).toString().split('\n').slice(0, 3).join(' | ') });
    }
  }));

  assert.equal(failed.length, 0, 'syntax errors: ' + JSON.stringify(failed, null, 2));
});
