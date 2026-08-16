import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIVE_NAME = 'typst-side-agent.zip';
export const CANONICAL_ROOTS = Object.freeze([
  'manifest.json', 'src', 'docs', 'icons', 'README.md', 'ARCHITECTURE.md', 'PRIVACY.md', 'TESTING.md',
  'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'ROADMAP.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE'
]);
const FORBIDDEN_EXTENSIONS = new Set(['.pem', '.key', '.crx', '.log', '.p12', '.pfx']);
const FIXED_DOS_DATE = 0x21; // 1980-01-01
const CRC_TABLE = makeCrcTable();

export async function collectPackageFiles(root) {
  const files = [];
  for (const entry of CANONICAL_ROOTS) await visit(resolve(root, entry));
  files.sort((a, b) => a.archivePath.localeCompare(b.archivePath, 'en'));
  await validatePackageInputs(root, files);
  return files;

  async function visit(absolute) {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the archive: ${archivePath(absolute)}`);
    if (stat.isDirectory()) {
      const children = await readdir(absolute);
      children.sort((a, b) => a.localeCompare(b, 'en'));
      for (const child of children) await visit(join(absolute, child));
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported package entry: ${archivePath(absolute)}`);
    const path = archivePath(absolute);
    validateArchivePath(path);
    files.push({ absolute, archivePath: path, size: stat.size });
  }

  function archivePath(absolute) {
    const path = relative(root, absolute).split(sep).join('/');
    if (!path || path.startsWith('../') || posix.isAbsolute(path)) throw new Error(`Package path escapes repository: ${absolute}`);
    return path;
  }
}

export async function validatePackageInputs(root, files, expectedTag = null) {
  const paths = new Set(files.map(file => file.archivePath));
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (manifest.version !== packageJson.version) throw new Error(`Version mismatch: manifest ${manifest.version}, package ${packageJson.version}`);
  if (expectedTag && expectedTag !== `v${manifest.version}`) throw new Error(`Release tag ${expectedTag} does not match v${manifest.version}`);

  const refs = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(item => item.js || []),
    ...(manifest.web_accessible_resources || []).flatMap(item => item.resources || [])
  ].filter(Boolean);
  for (const ref of refs) if (!paths.has(normalizeReference(ref))) throw new Error(`Manifest reference is missing from archive: ${ref}`);

  const sidepanelPath = normalizeReference(manifest.side_panel?.default_path || '');
  const sidepanelHtml = await readFile(resolve(root, sidepanelPath), 'utf8');
  for (const match of sidepanelHtml.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const ref = match[1];
    if (/^(?:https?:|data:|#)/i.test(ref)) continue;
    const target = posix.normalize(posix.join(posix.dirname(sidepanelPath), ref));
    if (!paths.has(target)) throw new Error(`Side-panel reference is missing from archive: ${target}`);
  }

  for (const file of files.filter(item => item.archivePath.endsWith('.js'))) {
    const source = await readFile(file.absolute, 'utf8');
    for (const match of source.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g)) {
      const ref = match[1];
      if (/^(?:https?:|data:)/i.test(ref)) continue;
      const target = posix.normalize(posix.join(posix.dirname(file.archivePath), ref));
      if (!paths.has(target)) throw new Error(`JavaScript source-map reference is missing from archive: ${target}`);
    }
  }

  for (const file of files.filter(item => item.archivePath.endsWith('.md'))) {
    const markdown = await readFile(file.absolute, 'utf8');
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const rawReference = match[1].trim().replace(/^<|>$/g, '');
      if (!rawReference || /^(?:https?:|mailto:|#)/i.test(rawReference)) continue;
      const reference = rawReference.split(/[?#]/, 1)[0];
      const target = posix.normalize(posix.join(posix.dirname(file.archivePath), reference));
      if (!paths.has(target)) throw new Error(`${file.archivePath} local link is missing from archive: ${target}`);
    }
  }
  return { version: manifest.version, paths };
}

export async function createArchive({ root, output, expectedTag = null }) {
  const files = await collectPackageFiles(root);
  const { version } = await validatePackageInputs(root, files, expectedTag);
  const records = [];
  for (const file of files) records.push({ name: file.archivePath, data: await readFile(file.absolute) });
  const archive = buildZip(records);
  const temp = `${output}.tmp-${process.pid}`;
  await writeFile(temp, archive, { flag: 'wx' });
  await rename(temp, output);
  return {
    version,
    fileCount: records.length,
    bytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    entries: records.map(record => record.name)
  };
}

export function buildZip(records) {
  if (records.length > 0xffff) throw new Error('ZIP entry count exceeds classic ZIP limits.');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const record of records) {
    const name = Buffer.from(record.name, 'utf8');
    const data = Buffer.from(record.data);
    if (name.length > 0xffff || data.length > 0xffffffff) throw new Error(`ZIP entry is too large: ${record.name}`);
    validateArchivePath(record.name);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function listZipEntries(buffer) {
  const signature = 0x06054b50;
  let endOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === signature) { endOffset = i; break; }
  }
  if (endOffset < 0) throw new Error('ZIP end record not found.');
  const count = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory.');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    validateArchivePath(name);
    entries.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function normalizeReference(value) {
  return posix.normalize(String(value || '').replace(/^\.\//, '').replaceAll('\\', '/'));
}

function validateArchivePath(path) {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`Invalid ZIP path: ${path}`);
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === '..' || normalized.startsWith('../')) throw new Error(`Unsafe ZIP path: ${path}`);
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment.startsWith('.'))) throw new Error(`Hidden or empty path segment is forbidden: ${path}`);
  const lower = path.toLowerCase();
  for (const extension of FORBIDDEN_EXTENSIONS) if (lower.endsWith(extension)) throw new Error(`Sensitive extension is forbidden: ${path}`);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
}

function parseCliArgs(argv) {
  const args = { expectedTag: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expected-tag') args.expectedTag = argv[++i] || null;
    else if (argv[i].startsWith('--expected-tag=')) args.expectedTag = argv[i].slice('--expected-tag='.length);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseCliArgs(process.argv.slice(2));
  const result = await createArchive({ root, output: resolve(root, ARCHIVE_NAME), expectedTag: args.expectedTag });
  console.log(`Packaged ${result.fileCount} files, ${result.bytes} bytes, v${result.version}, sha256 ${result.sha256}`);
}
