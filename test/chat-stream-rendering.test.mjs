import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('streaming content appends only new inert text and renders Markdown once at segment close', async () => {
  const source = await readFile(new URL('../src/sidepanel/chat.js', import.meta.url), 'utf8');
  const flush = source.slice(source.indexOf('export function flushPendingRender'), source.indexOf('function finalizeCurrentContentSegment'));
  const finalize = source.slice(source.indexOf('function finalizeCurrentContentSegment'), source.indexOf('function ensureContentSegment'));
  assert.match(flush, /slice\(state\.stream\.renderedContentChars/);
  assert.match(flush, /appendData\(pending\)/);
  assert.doesNotMatch(flush, /renderMarkdownInto/);
  assert.match(finalize, /renderMarkdownInto\(state\.stream\.currentContentEl, state\.stream\.currentText\)/);
});

test('unfinished Markdown remains a text node until the safe terminal render', async () => {
  const source = await readFile(new URL('../src/sidepanel/chat.js', import.meta.url), 'utf8');
  const ensure = source.slice(source.indexOf('function ensureContentSegment'), source.indexOf('export function appendChunk'));
  assert.match(ensure, /document\.createTextNode\(''\)/);
  assert.doesNotMatch(ensure, /innerHTML/);
});
