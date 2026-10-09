/**
 * Generate the classic-script copy of the dependency-free shared modules that
 * src/content/bridge-protocol.js exposes as `globalThis.__typstAgentShared`.
 *
 *   node scripts/sync-bridge-shared.mjs update   # rewrite the generated block
 *   node scripts/sync-bridge-shared.mjs verify   # fail when the block is stale
 *
 * The content scripts are plain scripts and cannot import ES modules, so this
 * keeps one source of truth for path normalization, file labels, and page
 * bounds instead of hand-synchronized copies.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHARED_SOURCES = Object.freeze(['src/shared/page-limits.js', 'src/shared/active-file.js']);
export const BRIDGE_FILE = 'src/content/bridge-protocol.js';
export const BEGIN_MARKER = '  // BEGIN GENERATED SHARED RUNTIME';
export const END_MARKER = '  // END GENERATED SHARED RUNTIME';

const EXPORT_DECLARATION = /^export (?=(?:async )?(?:function|const|let|class) )/gm;
const EXPORT_NAME = /^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm;
const FORBIDDEN = [/^\s*import\s/m, /^\s*export\s+\{/m, /^\s*export\s+\*/m, /^\s*export\s+default\b/m, /\bimport\(/];

export async function renderSharedRuntimeBlock(root) {
  const bodies = [];
  const names = [];
  const hash = createHash('sha256');
  for (const file of SHARED_SOURCES) {
    const source = await readFile(resolve(root, file), 'utf8');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(source)) throw new Error(`${file} must be a dependency-free leaf module with inline exports only.`);
    }
    hash.update(`${file}\n${source}\n`);
    names.push(...[...source.matchAll(EXPORT_NAME)].map(match => match[1]));
    const stripped = source.replace(/^\/\*\*[\s\S]*?\*\/\n+/, '').replace(EXPORT_DECLARATION, '').trimEnd();
    bodies.push(`    // ---- ${file} ----`, ...stripped.split('\n').map(line => (line ? `    ${line}` : '')));
  }
  const digest = hash.digest('hex').slice(0, 16);
  return [
    BEGIN_MARKER,
    `  // Generated from ${SHARED_SOURCES.join(' and ')} by scripts/sync-bridge-shared.mjs.`,
    '  // Do not edit by hand: change the shared module, then run `npm run sync:bridge`.',
    '  (function () {',
    `    const SHARED_RUNTIME_HASH = '${digest}';`,
    '    if (root.__typstAgentShared?.hash === SHARED_RUNTIME_HASH) return;',
    ...bodies,
    `    root.__typstAgentShared = Object.freeze({ hash: SHARED_RUNTIME_HASH, ${names.join(', ')} });`,
    '  })();',
    END_MARKER
  ].join('\n');
}

export function replaceSharedRuntimeBlock(bridgeSource, block) {
  const begin = bridgeSource.indexOf(BEGIN_MARKER);
  const end = bridgeSource.indexOf(END_MARKER);
  if (begin < 0 || end < begin) throw new Error(`${BRIDGE_FILE} is missing the generated shared runtime markers.`);
  return bridgeSource.slice(0, begin) + block + bridgeSource.slice(end + END_MARKER.length);
}

export async function syncBridgeShared(root, mode) {
  const bridgePath = resolve(root, BRIDGE_FILE);
  const current = await readFile(bridgePath, 'utf8');
  const next = replaceSharedRuntimeBlock(current, await renderSharedRuntimeBlock(root));
  if (mode === 'update') {
    if (next !== current) await writeFile(bridgePath, next);
    return { changed: next !== current };
  }
  if (next !== current) throw new Error(`${BRIDGE_FILE} shared runtime block is stale. Run: npm run sync:bridge`);
  return { changed: false };
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const mode = process.argv[2] || 'verify';
  if (!['verify', 'update'].includes(mode)) throw new Error('Usage: sync-bridge-shared.mjs <verify|update>');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = await syncBridgeShared(root, mode);
    console.log(mode === 'update'
      ? (result.changed ? `Updated the shared runtime block in ${BRIDGE_FILE}.` : `${BRIDGE_FILE} shared runtime block is already current.`)
      : `${BRIDGE_FILE} shared runtime block matches ${SHARED_SOURCES.join(' and ')}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
