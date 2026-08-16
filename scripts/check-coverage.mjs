import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFiles = (await readdir(resolve(root, 'test')))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `test/${name}`);
const run = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', ...testFiles], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
});
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0) process.exit(run.status || 1);

const floors = new Map([
  ['agent.js', 65],
  ['mcp.js', 80],
  ['provider.js', 85],
  ['storage.js', 75],
  ['tool-validation.js', 80],
  ['float-controller.js', 85],
  ['registry-controller.js', 80],
  ['run-ui-controller.js', 90],
  ['session-import.js', 85],
  ['transition-coordinator.js', 90]
]);
const measured = new Map();
for (const line of (run.stdout || '').split(/\r?\n/)) {
  const match = line.match(/\b([A-Za-z0-9.-]+\.js)\s+\|\s+([0-9.]+)/);
  if (match) measured.set(match[1], Number(match[2]));
}
const failures = [];
for (const [file, floor] of floors) {
  const value = measured.get(file);
  if (!Number.isFinite(value)) failures.push(`${file}: missing from coverage report`);
  else if (value < floor) failures.push(`${file}: ${value.toFixed(2)}% lines is below ${floor}%`);
  else console.log(`coverage floor: ${file} ${value.toFixed(2)}% >= ${floor}%`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
