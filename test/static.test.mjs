import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listShippedJs } from '../scripts/list-shipped-js.mjs';
import { MAIN_WORLD_FILES } from '../src/background/content-bootstrap.js';

const execFile = promisify(execFileCb);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

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

test('workflows pin actions, declare least privilege, and use canonical packaging', async () => {
  const ci = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'release-chrome.yml'), 'utf8');
  for (const source of [ci, release]) {
    assert.doesNotMatch(source, /uses:\s*[^\s]+@(v\d+|main|master)\s*$/m);
    for (const match of source.matchAll(/uses:\s*[^\s]+@([^\s#]+)/g)) assert.match(match[1], /^[0-9a-f]{40}$/);
    assert.match(source, /permissions:\s*\r?\n\s+contents:\s*read/);
    assert.match(source, /npm run package/);
    assert.doesNotMatch(source, /zip\s+-r/);
  }
  assert.match(ci, /npm run verify/);
  assert.match(ci, /npm run test:browser/);
  assert.match(release, /environment:\s*chrome-web-store/);
  assert.match(release, /--expected-tag/);
  assert.match(release, /npm run test:browser/);
  assert.match(release, /npm run package:check/);
  assert.match(release, /publish:\s*[\s\S]*needs:\s*build[\s\S]*environment:\s*chrome-web-store/);
  assert.ok(release.indexOf('npm run verify') < release.indexOf('environment: chrome-web-store'));
});

test('manifest and package versions are exactly equal', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('documented Node floor matches the pinned verification toolchain', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=20.19.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
});

test('content bridge adapter loads before isolated code and exposes all main-world assets', () => {
  assert.deepEqual(manifest.content_scripts[0].js.slice(0, 2), ['src/content/bridge-protocol.js', 'src/content/isolated.js']);
  const resources = new Set(manifest.web_accessible_resources.flatMap(item => item.resources));
  for (const path of MAIN_WORLD_FILES) assert.ok(resources.has(path), path);
});

test('normal registration and isolated recovery use the exact same main-world order', async () => {
  const isolated = await readFile(path.join(REPO_ROOT, 'src', 'content', 'isolated.js'), 'utf8');
  const literal = isolated.match(/const MAIN_WORLD_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(literal, 'isolated recovery list is declared');
  const recoveryFiles = [...literal[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(recoveryFiles, MAIN_WORLD_FILES);
});

test('the obsolete direct page-tool mutation protocol cannot return', async () => {
  for (const relative of [
    'src/shared/protocol.js',
    'src/content/bridge-protocol.js',
    'src/content/main.js',
    'src/background/agent.js'
  ]) {
    const source = await readFile(path.join(REPO_ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /PAGE_EXECUTE_TOOL/);
  }
});

test('side panel ships response recovery with in-panel revert, restore, and delete dialogs', async () => {
  const [html, app, chat, controller, styles] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'index.html'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'app.js'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'chat.js'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'snapshot-controller.js'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'styles.css'), 'utf8')
  ]);
  assert.doesNotMatch(html, /id="snapshot-btn"/);
  assert.doesNotMatch(html, /id="snapshot-create"/);
  assert.match(html, /id="snapshot-menu"/);
  assert.match(html, /id="snapshot-dialog-layer"/);
  assert.match(html, /id="snapshot-dialog-confirm"/);
  assert.match(html, /id="revert-dialog-layer"/);
  assert.match(html, /id="revert-dialog-confirm"/);
  assert.match(app, /createSnapshotController/);
  assert.match(chat, /responseStatus === 'complete'/);
  assert.match(chat, /response-snapshot-button/);
  assert.match(chat, /openRevertConfirmation/);
  assert.doesNotMatch(chat, /globalThis\.confirm/);
  assert.match(controller, /DOCUMENT_SNAPSHOT_PREVIEW/);
  assert.match(controller, /DOCUMENT_SNAPSHOT_RESTORE/);
  assert.match(controller, /renderDeleteDialog/);
  assert.match(controller, /dialogMode = 'delete'/);
  assert.doesNotMatch(controller, /globalThis\.confirm/);
  assert.match(styles, /\.snapshot-menu\s*\{/);
  assert.match(styles, /\.snapshot-dialog-layer\s*\{/);
  assert.match(styles, /\.snapshot-dialog-note\.is-danger/);
  assert.match(styles, /\.revert-dialog\s*\{/);
});

test('side panel exposes one About dialog from the logo and General settings', async () => {
  const [html, app, styles] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'index.html'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'app.js'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'styles.css'), 'utf8')
  ]);
  assert.match(html, /id="about-icon-button"/);
  assert.match(html, /id="about-settings-button"/);
  assert.match(html, /id="about-dialog-layer"/);
  assert.match(html, /href="https:\/\/github\.com\/dbccccccc\/Typst-Side-Agent"/);
  assert.match(html, /href="https:\/\/forum\.typst\.app\/u\/dbcccc\/summary"/);
  assert.match(html, /href="https:\/\/chromewebstore\.google\.com\/detail\/eljacjoifoamnmbclmhlpcdabdioleab"/);
  assert.match(app, /CHROME_WEB_STORE_URL/);
  assert.match(app, /chrome\.runtime\.getManifest\(\)/);
  assert.doesNotMatch(app, /chrome\.runtime\.id/);
  assert.match(app, /openAboutDialog/);
  assert.match(styles, /\.about-settings-button\s*\{/);
  assert.match(styles, /\.about-dialog\s*\{/);
  assert.match(styles, /\.about-resource-link\s*\{/);
});

test('auto-name failures are routed to the shared top notification', async () => {
  const app = await readFile(path.join(REPO_ROOT, 'src', 'sidepanel', 'app.js'), 'utf8');
  assert.match(app, /Chat auto-name failed:/);
  assert.match(app, /setStatus\(`Chat auto-name failed: \$\{error\?\.message \|\| String\(error\)\}`, true\)/);
  assert.doesNotMatch(app, /Naming is best-effort and must never block sending/);
});

// ---------- Syntax check on every shipped JS module ----------

test('every src/**/*.js file parses cleanly', async () => {
  const files = await listShippedJs(REPO_ROOT);
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
