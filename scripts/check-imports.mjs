import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL } from '../src/shared/protocol.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(root, 'src');
const files = await walk(srcRoot);
const graph = new Map();
const errors = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const dependencies = [];
  for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    const resolved = target.endsWith('.js') ? target : `${target}.js`;
    if (!files.includes(resolved)) errors.push(`${label(file)} imports missing ${label(resolved)}`);
    else dependencies.push(resolved);
  }
  graph.set(file, dependencies);
  if (!file.endsWith(`${sep}shared${sep}protocol.js`)) {
    for (const match of source.matchAll(/(?:type\s*:\s*|case\s+)(['"])([A-Z][A-Z0-9_]+)\1/g)) {
      if (Object.values(PROTOCOL).includes(match[2])) errors.push(`${label(file)} contains raw protocol literal ${match[2]}`);
    }
  }
}

const protocolFile = resolve(srcRoot, 'shared', 'protocol.js');
if ((graph.get(protocolFile) || []).length) errors.push('src/shared/protocol.js must remain dependency-free.');

const allowedLayers = {
  shared: new Set(['shared']),
  background: new Set(['background', 'shared']),
  content: new Set(['content', 'shared']),
  sidepanel: new Set(['sidepanel', 'shared'])
};
for (const [file, dependencies] of graph) {
  const sourceLayer = layer(file);
  for (const dependency of dependencies) {
    const targetLayer = layer(dependency);
    if (!allowedLayers[sourceLayer]?.has(targetLayer)) {
      errors.push(`${label(file)} crosses the ${sourceLayer} -> ${targetLayer} layer boundary via ${label(dependency)}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(file, stack = []) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    errors.push(`Import cycle: ${[...stack.slice(start), file].map(label).join(' -> ')}`);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of graph.get(file) || []) visit(dependency, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file);

const adapter = await readFile(resolve(srcRoot, 'content', 'bridge-protocol.js'), 'utf8');
for (const match of adapter.matchAll(/:\s*'([A-Z][A-Z0-9_]+)'/g)) {
  if (!Object.values(PROTOCOL).includes(match[1])) errors.push(`Page adapter constant is absent from shared protocol: ${match[1]}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} source modules: valid layer boundaries, no cycles, and no raw protocol dispatch literals.`);
}

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) out.push(path);
  }
  return out;
}

function label(file) {
  return relative(root, file).split(sep).join('/');
}

function layer(file) {
  return relative(srcRoot, file).split(sep)[0];
}
