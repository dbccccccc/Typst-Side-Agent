// Runs the inline Chrome Web Store publish script from the release workflow
// against a local mock of the store API, so the shipped script itself is tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLISHER = 'publisher-1';
const EXTENSION = 'abcdefghijklmnopabcdefghijklmnop';
const ITEM = `/publishers/${PUBLISHER}/items/${EXTENSION}`;
const TOKEN = 'test-access-token';

async function publishScript() {
  const workflow = (await readFile(path.join(ROOT, '.github/workflows/release-chrome.yml'), 'utf8')).replace(/\r\n/g, '\n');
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => line.trimEnd().endsWith("node --input-type=module <<'NODE'"));
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'NODE');
  assert.ok(start >= 0 && end > start, 'the release workflow embeds the publish script in a NODE heredoc');
  const indent = lines[end].length - lines[end].trimStart().length;
  return lines.slice(start + 1, end).map(line => line.slice(indent)).join('\n');
}

const SCRIPT = await publishScript();

function startStore(routes) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    const route = routes[`${request.method} ${request.url}`];
    const reply = typeof route === 'function' ? route(entry, requests) : route;
    if (!reply) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unexpected request' } }));
      return;
    }
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function runPublish(routes, envOverrides = {}) {
  const store = await startStore(routes);
  const dir = await mkdtemp(path.join(tmpdir(), 'cws-publish-'));
  const zipPath = path.join(dir, 'typst-side-agent.zip');
  const summaryPath = path.join(dir, 'summary.md');
  const zipBytes = Buffer.from('PK\u0003\u0004 fake release package');
  await writeFile(zipPath, zipBytes);
  await writeFile(summaryPath, '');
  const script = SCRIPT
    .replace("const API = 'https://chromewebstore.googleapis.com';", `const API = '${store.base}';`)
    .replace('const POLL_INTERVAL_MS = 10000;', 'const POLL_INTERVAL_MS = 5;');
  assert.ok(script.includes(store.base) && script.includes('POLL_INTERVAL_MS = 5;'), 'test hooks were applied');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    CWS_ACCESS_TOKEN: TOKEN,
    CWS_PUBLISHER_ID: PUBLISHER,
    CWS_EXTENSION_ID: EXTENSION,
    RELEASE_TAG: 'v1.2.3',
    PACKAGE_PATH: zipPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    ...envOverrides
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(script);
    });
    return { ...result, requests: store.requests, zipBytes, summary: await readFile(summaryPath, 'utf8') };
  } finally {
    store.server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const uploadRoute = `POST /upload/v2${ITEM}:upload`;
const statusRoute = `GET /v2${ITEM}:fetchStatus`;
const publishRoute = `POST /v2${ITEM}:publish`;

test('publish script uploads the package, submits it, and records the store state', async () => {
  const run = await runPublish({
    [uploadRoute]: { body: { itemId: EXTENSION, uploadState: 'SUCCEEDED', crxVersion: '1.2.3' } },
    [publishRoute]: { body: { itemId: EXTENSION, state: 'PENDING_REVIEW' } }
  });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.deepEqual(run.requests.map(request => `${request.method} ${request.url}`), [uploadRoute, publishRoute]);
  for (const request of run.requests) assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(run.requests[0].body, run.zipBytes, 'the verified ZIP is uploaded byte for byte');
  assert.equal(run.requests[1].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(run.requests[1].body.toString()), { publishType: 'DEFAULT_PUBLISH' });
  assert.match(run.stdout, /Submitted v1\.2\.3 to the Chrome Web Store\. Store state: PENDING_REVIEW\./);
  assert.match(run.summary, /Store state: `PENDING_REVIEW`/);
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(TOKEN), 'the access token is never printed');
});

test('publish script waits for an asynchronous upload before submitting', async () => {
  let checks = 0;
  const run = await runPublish({
    [uploadRoute]: { body: { itemId: EXTENSION, uploadState: 'UPLOAD_IN_PROGRESS' } },
    [statusRoute]: () => {
      checks += 1;
      return { body: { itemId: EXTENSION, lastAsyncUploadState: checks < 2 ? 'IN_PROGRESS' : 'SUCCEEDED' } };
    },
    [publishRoute]: { body: { itemId: EXTENSION, state: 'PUBLISHED' } }
  });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(checks, 2);
  assert.equal(run.requests.at(-1).url, `/v2${ITEM}:publish`);
});

test('publish script stops before submitting when the upload fails', async () => {
  const httpError = await runPublish({
    [uploadRoute]: { status: 403, body: { error: { code: 403, message: 'The caller does not have permission' } } }
  });
  assert.equal(httpError.code, 1);
  assert.match(httpError.stdout, /::error::Chrome Web Store upload request failed with HTTP 403\./);
  assert.match(httpError.stderr, /does not have permission/);
  assert.equal(httpError.requests.length, 1, 'publish is never called');

  const failedState = await runPublish({
    [uploadRoute]: { body: { itemId: EXTENSION, uploadState: 'FAILED' } }
  });
  assert.equal(failedState.code, 1);
  assert.match(failedState.stdout, /The package upload did not succeed \(state: FAILED\)\./);
  assert.equal(failedState.requests.length, 1);

  const wrongVersion = await runPublish({
    [uploadRoute]: { body: { itemId: EXTENSION, uploadState: 'SUCCEEDED', crxVersion: '1.2.2' } }
  });
  assert.equal(wrongVersion.code, 1);
  assert.match(wrongVersion.stdout, /The store read version 1\.2\.2 from the package; expected 1\.2\.3\./);
  assert.equal(wrongVersion.requests.length, 1);
});

test('publish script fails on a rejected submission and surfaces store warnings', async () => {
  const run = await runPublish({
    [uploadRoute]: { body: { itemId: EXTENSION, uploadState: 'SUCCEEDED' } },
    [publishRoute]: {
      body: {
        itemId: EXTENSION,
        state: 'REJECTED',
        warningInfo: { warnings: [{ reason: 'POLICY', description: 'Line one\nline two' }] }
      }
    }
  });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /::warning::POLICY: Line one%0Aline two/);
  assert.match(run.stdout, /::error::The store did not accept the submission \(state: REJECTED\)\./);
  assert.equal(run.summary, '');
});

test('publish script refuses to run without its environment secrets', async () => {
  const run = await runPublish({}, { CWS_PUBLISHER_ID: undefined });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /::error::CWS_PUBLISHER_ID is not set\./);
  assert.equal(run.requests.length, 0);
});
