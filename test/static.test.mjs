import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { listShippedJs } from '../scripts/list-shipped-js.mjs';
import { MAIN_WORLD_FILES } from '../src/background/content-bootstrap.js';

const execFile = promisify(execFileCb);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = relative => readFile(path.join(REPO_ROOT, relative), 'utf8');
const manifest = JSON.parse(await read('manifest.json'));
const pkg = JSON.parse(await read('package.json'));

// ---------- manifest.json ----------

test('manifest.json declares the MV3 entry points and every referenced file exists', async () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.background?.type, 'module');
  const referenced = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...(manifest.content_scripts || []).flatMap(script => script.js || []),
    ...(manifest.web_accessible_resources || []).flatMap(item => item.resources || [])
  ];
  for (const relative of referenced) {
    await assert.doesNotReject(readFile(path.join(REPO_ROOT, relative)), `missing file: ${relative}`);
  }
});

test('manifest and package versions are exactly equal and the Node floor is pinned consistently', async () => {
  assert.equal(manifest.version, pkg.version);
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(pkg.engines.node, '>=24.15.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
});

// ---------- content-script bootstrap ----------

test('the bridge adapter loads first in both worlds and every main-world asset is web accessible', async () => {
  assert.deepEqual(manifest.content_scripts[0].js.slice(0, 2), ['src/content/bridge-protocol.js', 'src/content/isolated.js']);
  assert.equal(MAIN_WORLD_FILES[0], 'src/content/bridge-protocol.js');
  const resources = new Set(manifest.web_accessible_resources.flatMap(item => item.resources));
  for (const file of MAIN_WORLD_FILES) assert.ok(resources.has(file), file);
  const isolated = await read('src/content/isolated.js');
  const literal = isolated.match(/const MAIN_WORLD_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(literal, 'isolated recovery list is declared');
  const recoveryFiles = [...literal[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(recoveryFiles, MAIN_WORLD_FILES);
});

test('the obsolete direct page-tool mutation protocol cannot return', async () => {
  for (const relative of ['src/shared/protocol.js', 'src/content/bridge-protocol.js', 'src/content/main.js']) {
    assert.doesNotMatch(await read(relative), /PAGE_EXECUTE_TOOL/);
  }
  for (const entry of await readdir(path.join(REPO_ROOT, 'src', 'background', 'agent'))) {
    assert.doesNotMatch(await read(`src/background/agent/${entry}`), /PAGE_EXECUTE_TOOL/);
  }
});

// ---------- workflows ----------

test('workflows pin actions to commits, run the full gates, and keep publishing behind the protected environment', async () => {
  const ci = await read('.github/workflows/ci.yml');
  const release = await read('.github/workflows/release-chrome.yml');
  for (const source of [ci, release]) {
    for (const match of source.matchAll(/uses:\s*[^\s]+@([^\s#]+)/g)) assert.match(match[1], /^[0-9a-f]{40}$/, 'actions must be pinned to a commit');
    assert.match(source, /permissions:\s*\r?\n\s+contents:\s*read/);
    assert.match(source, /npm run verify/);
    assert.match(source, /npm run audit:release/);
    assert.match(source, /npm run package\b/);
    assert.match(source, /npx --no-install playwright-core install --with-deps chromium/);
    assert.ok((source.match(/npm run test:browser/g) || []).length >= 2, 'browser smoke runs at least twice');
    assert.doesNotMatch(source, /zip\s+-r/);
    assert.doesNotMatch(source, /npx\s+playwright\b/);
  }
  const nodeFloor = pkg.engines.node.replace(/^>=/, '');
  assert.ok(ci.includes(`'${nodeFloor}'`), `CI covers the package Node floor ${nodeFloor}`);
  assert.match(release, /environment:\s*chrome-web-store/);
  assert.match(release, /--expected-tag/);
  assert.match(release, /npm run package:check/);
  assert.match(release, /^ {2}RELEASE_TAG:\s*\$\{\{ github\.event\.release\.tag_name \|\| inputs\.tag \}\}$/m);
  for (const source of [/github\.event\.release\.tag_name/g, /inputs\.tag/g]) {
    assert.equal((release.match(source) || []).length, 1, 'the tag reaches steps only through the RELEASE_TAG env var');
  }
  assert.ok(release.indexOf('npm run verify') < release.indexOf('environment: chrome-web-store'), 'verification precedes publishing');
});

test('store publishing uses a short-lived service-account token in a job that runs no repository code', async () => {
  const release = (await read('.github/workflows/release-chrome.yml')).replace(/\r\n/g, '\n');
  const header = release.slice(0, release.indexOf('\njobs:'));
  const build = release.slice(release.indexOf('\n  build:'), release.indexOf('\n  publish:'));
  const publish = release.slice(release.indexOf('\n  publish:'));
  assert.doesNotMatch(header, /id-token/, 'OIDC tokens are not granted workflow-wide');
  assert.doesNotMatch(build, /id-token|secrets\./, 'the build job holds no store credentials');
  assert.match(publish, /environment: chrome-web-store/);
  assert.match(publish, /permissions:\n\s+contents: read\n(?:\s+#.*\n)*\s+id-token: write\n/);
  assert.doesNotMatch(publish, /actions\/checkout|npm (?:ci|run)/, 'the publishing job runs no repository code');
  assert.match(publish, /uses: google-github-actions\/auth@[0-9a-f]{40} /);
  assert.match(publish, /token_format: access_token\n/);
  assert.match(publish, /access_token_scopes: https:\/\/www\.googleapis\.com\/auth\/chromewebstore\n/);
  assert.match(publish, /create_credentials_file: false\n/);
  assert.match(publish, /export_environment_variables: false\n/);
  assert.match(publish, /chromewebstore\.googleapis\.com/);
  assert.doesNotMatch(release, /refresh[-_]token|client[-_]secret|credentials_json/i, 'no long-lived store credentials');
  assert.doesNotMatch(publish.slice(publish.indexOf("<<'NODE'")), /\$\{\{/, 'the publish script receives values only through env vars');
});

// ---------- public documents ----------

test('public release documents track the current package and the private reporting route', async () => {
  const [changelog, security, privacy, readme, testing] = await Promise.all([
    read('CHANGELOG.md'), read('SECURITY.md'), read('PRIVACY.md'), read('README.md'), read('TESTING.md')
  ]);
  const versionHeading = new RegExp(`^## \\[${manifest.version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  assert.match(changelog, versionHeading);
  assert.match(security, /security\/advisories\/new/);
  assert.match(privacy, /\[SECURITY\.md\]\(\.\/SECURITY\.md\)/);
  for (const document of ['CHANGELOG.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(readme, new RegExp(`\\[${document.replace('.', '\\.')}\\]\\(\\.\\/${document.replace('.', '\\.')}\\)`));
  }
  const checklist = testing.slice(testing.indexOf('## Release checklist'));
  const html = marked.parse(checklist);
  assert.match(html, /<ol>/, 'the release checklist is an ordered list');
  assert.match(html, /npm run audit:release/);
  assert.match(html, /npm run package:check/);
});

// ---------- side-panel structure ----------

test('response recovery uses in-panel dialogs and never a native confirm()', async () => {
  const html = await read('src/sidepanel/index.html');
  for (const id of ['snapshot-menu', 'snapshot-dialog-layer', 'snapshot-dialog-confirm', 'revert-dialog-layer', 'revert-dialog-confirm', 'about-dialog-layer']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /id="snapshot-btn"|id="snapshot-create"/, 'snapshot creation is automatic, not a composer action');
  const sidepanelFiles = (await readdir(path.join(REPO_ROOT, 'src', 'sidepanel'))).filter(name => name.endsWith('.js'));
  for (const name of sidepanelFiles) {
    assert.doesNotMatch(await read(`src/sidepanel/${name}`), /globalThis\.confirm|window\.confirm/, name);
  }
  const revertControl = await read('src/sidepanel/revert-control.js');
  assert.match(revertControl, /revert-dialog-confirm/);
  assert.match(revertControl, /response-snapshot-button/);
  const snapshotController = await read('src/sidepanel/snapshot-controller.js');
  assert.match(snapshotController, /DOCUMENT_SNAPSHOT_PREVIEW/);
  assert.match(snapshotController, /DOCUMENT_SNAPSHOT_RESTORE/);
});

test('the About dialog links only to the project, the Typst forum profile, and the store listing', async () => {
  const html = await read('src/sidepanel/index.html');
  assert.match(html, /id="about-icon-button"/);
  assert.match(html, /id="about-settings-button"/);
  const links = [...html.matchAll(/class="about-resource-link"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="about-resource-link"/g)]
    .map(match => match[1] || match[2]);
  assert.deepEqual(links, [
    'https://github.com/dbccccccc/Typst-Side-Agent',
    'https://forum.typst.app/u/dbcccc/summary',
    'https://chromewebstore.google.com/detail/eljacjoifoamnmbclmhlpcdabdioleab'
  ]);
  const sources = await Promise.all((await readdir(path.join(REPO_ROOT, 'src', 'sidepanel')))
    .filter(name => name.endsWith('.js'))
    .map(name => read(`src/sidepanel/${name}`)));
  assert.ok(sources.some(source => /chrome\.runtime\.getManifest\(\)/.test(source)), 'the version label comes from the manifest');
  assert.ok(sources.every(source => !/chrome\.runtime\.id/.test(source)), 'the extension id is never read at runtime');
});

// ---------- syntax ----------

test('every shipped src/**/*.js file parses cleanly', async () => {
  const files = await listShippedJs(REPO_ROOT);
  assert.ok(files.length > 0, 'found at least one source file');
  const failed = [];
  await Promise.all(files.map(async rel => {
    try {
      await execFile(process.execPath, ['--check', path.join(REPO_ROOT, rel)]);
    } catch (e) {
      failed.push({ rel, err: (e.stderr || e.message).toString().split('\n').slice(0, 3).join(' | ') });
    }
  }));
  assert.equal(failed.length, 0, 'syntax errors: ' + JSON.stringify(failed, null, 2));
});
