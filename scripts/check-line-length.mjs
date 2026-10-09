/**
 * Enforce a maximum source line length for shipped code and tooling.
 *
 *   node scripts/check-line-length.mjs            # fail on lines over the limit
 *   node scripts/check-line-length.mjs --report   # list offenders without failing
 *
 * Vendored libraries, the generated shared-runtime block, and the prose-only
 * system prompt module are excluded; everything else must stay readable in a
 * side-by-side diff.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_LINE_LENGTH = 160;
const ROOTS = ['src', 'scripts'];
const IGNORED_PREFIXES = ['src/sidepanel/lib/'];
const IGNORED_FILES = new Set(['src/shared/system-prompt.js']);
const GENERATED_BEGIN = '// BEGIN GENERATED SHARED RUNTIME';
const GENERATED_END = '// END GENERATED SHARED RUNTIME';

export async function findLongLines(root, limit = MAX_LINE_LENGTH) {
  const offenders = [];
  for (const entry of ROOTS) {
    for (const file of await walk(resolve(root, entry))) {
      const label = relative(root, file).split(sep).join('/');
      if (IGNORED_FILES.has(label) || IGNORED_PREFIXES.some(prefix => label.startsWith(prefix))) continue;
      const lines = (await readFile(file, 'utf8')).split('\n');
      let generated = false;
      lines.forEach((line, index) => {
        if (line.includes(GENERATED_BEGIN)) generated = true;
        if (line.includes(GENERATED_END)) generated = false;
        if (!generated && line.length > limit) offenders.push({ file: label, line: index + 1, length: line.length });
      });
    }
  }
  return offenders;
}

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) && !entry.name.endsWith('.min.js')) out.push(path);
  }
  return out;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = process.argv.includes('--report');
  const offenders = await findLongLines(root);
  for (const item of offenders) console.log(`${item.file}:${item.line} ${item.length} > ${MAX_LINE_LENGTH}`);
  if (offenders.length && !report) {
    console.error(`${offenders.length} line(s) exceed ${MAX_LINE_LENGTH} characters.`);
    process.exitCode = 1;
  } else if (!offenders.length) {
    console.log(`All source and script lines are within ${MAX_LINE_LENGTH} characters.`);
  }
}
