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

/**
 * Risk-weighted line-coverage floors. Module basenames are unique across src/
 * so the Node coverage table can be matched by name. Raise a floor when a
 * module gains tests; never lower one without a review note.
 */
const floors = new Map([
  // Worker: run orchestration and tool execution
  ['run-loop.js', 90],
  ['tool-preflight.js', 85],
  ['editor-tool-runner.js', 70],
  ['read-tool-runner.js', 85],
  ['external-tool-runner.js', 75],
  ['page-bridge.js', 80],
  ['run-transcript.js', 90],
  ['session-title.js', 90],
  // Worker: transports and validation
  ['mcp.js', 80],
  ['provider.js', 85],
  ['tool-validation.js', 80],
  ['protocol.js', 80],
  ['edit-preview.js', 90],
  ['edit-revert.js', 80],
  // Worker: storage
  ['storage-core.js', 85],
  ['session-store.js', 85],
  ['checkpoint-store.js', 85],
  ['snapshot-store.js', 80],
  ['settings-store.js', 75],
  ['integration-store.js', 90],
  // Content scripts (loaded through vm in tests)
  ['float-controller.js', 85],
  // Side panel
  ['chat.js', 85],
  ['stream-view.js', 90],
  ['tool-blocks.js', 85],
  ['revert-control.js', 85],
  ['markdown.js', 85],
  ['send-controller.js', 85],
  ['quick-attach-controller.js', 90],
  ['snapshot-controller.js', 80],
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
