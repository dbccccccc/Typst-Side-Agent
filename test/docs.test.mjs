import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DOC_TOPICS, listDocTopics, resolveTopicId } from '../src/background/docs.js';
import { BUILTIN_TOOLS } from '../src/background/tools.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------- DOC_TOPICS integrity ----------

test('DOC_TOPICS: every entry points at a real bundled markdown file', async () => {
  for (const topic of DOC_TOPICS) {
    const abs = path.join(REPO_ROOT, 'docs', 'typst', topic.file);
    await access(abs); // throws if missing
  }
});

test('DOC_TOPICS: topic ids and files are unique', () => {
  const ids = DOC_TOPICS.map(t => t.id);
  const files = DOC_TOPICS.map(t => t.file);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  assert.equal(new Set(files).size, files.length, 'files unique');
});

test('listDocTopics: returns id + title + summary for every topic', () => {
  const out = listDocTopics();
  assert.equal(out.length, DOC_TOPICS.length);
  for (const entry of out) {
    assert.ok(entry.id && typeof entry.id === 'string');
    assert.ok(entry.title && typeof entry.title === 'string');
    assert.ok(entry.summary && typeof entry.summary === 'string');
  }
});

// ---------- resolveTopicId ----------

test('resolveTopicId: canonical ids pass through', () => {
  assert.equal(resolveTopicId('markup'), 'markup');
  assert.equal(resolveTopicId('math'), 'math');
  assert.equal(resolveTopicId('cheat-sheet'), 'cheat-sheet');
});

test('resolveTopicId: numeric inputs map by index', () => {
  assert.equal(resolveTopicId('1'), 'syntax-basics');
  assert.equal(resolveTopicId('3'), 'math');
  assert.equal(resolveTopicId('12'), 'cheat-sheet');
});

test('resolveTopicId: zero-padded index and file stem both work', () => {
  assert.equal(resolveTopicId('01'), 'syntax-basics');
  assert.equal(resolveTopicId('01-syntax-basics'), 'syntax-basics');
  assert.equal(resolveTopicId('12-cheat-sheet.md'), 'cheat-sheet');
});

test('resolveTopicId: common aliases resolve', () => {
  assert.equal(resolveTopicId('cheatsheet'), 'cheat-sheet');
  assert.equal(resolveTopicId('introspection'), 'context');
  assert.equal(resolveTopicId('elements'), 'model');
  assert.equal(resolveTopicId('data'), 'data-loading');
  assert.equal(resolveTopicId('STYLE'), 'styling'); // case-insensitive
});

test('resolveTopicId: unknown / empty returns null', () => {
  assert.equal(resolveTopicId(''), null);
  assert.equal(resolveTopicId(null), null);
  assert.equal(resolveTopicId(undefined), null);
  assert.equal(resolveTopicId('not-a-topic'), null);
  assert.equal(resolveTopicId('99'), null);
});

// ---------- Tool registration ----------

test('BUILTIN_TOOLS: read_typst_docs is registered with a topic parameter', () => {
  const tool = BUILTIN_TOOLS.find(t => t.function.name === 'read_typst_docs');
  assert.ok(tool, 'read_typst_docs tool is present');
  assert.equal(tool.function.parameters.type, 'object');
  assert.ok(tool.function.parameters.properties.topic, 'has topic param');
  assert.equal(tool.function.parameters.properties.topic.type, 'string');
});

// ---------- Bundled markdown sanity ----------

test('bundled docs: every file has a level-1 heading', async () => {
  for (const topic of DOC_TOPICS) {
    const abs = path.join(REPO_ROOT, 'docs', 'typst', topic.file);
    const content = await readFile(abs, 'utf8');
    assert.ok(content.trim().startsWith('# '), `${topic.file} starts with # heading`);
  }
});
