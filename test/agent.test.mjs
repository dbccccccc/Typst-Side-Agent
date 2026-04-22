import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractReasoningChunk,
  splitInlineThink,
  sortToolCallsForExecution,
  sanitizeTitle
} from '../src/background/agent.js';

// ---------- extractReasoningChunk ----------

test('extractReasoningChunk: reasoning_content (DeepSeek / Qwen / Kimi)', () => {
  assert.equal(extractReasoningChunk({ reasoning_content: 'step 1' }), 'step 1');
});

test('extractReasoningChunk: reasoning as string (OpenRouter / Together)', () => {
  assert.equal(extractReasoningChunk({ reasoning: 'thinking...' }), 'thinking...');
});

test('extractReasoningChunk: reasoning.content object (newer OpenAI-compat)', () => {
  assert.equal(extractReasoningChunk({ reasoning: { content: 'deep thought' } }), 'deep thought');
});

test('extractReasoningChunk: thinking key (llama.cpp / vLLM proxies)', () => {
  assert.equal(extractReasoningChunk({ thinking: 'hmm' }), 'hmm');
});

test('extractReasoningChunk: missing / empty returns empty string', () => {
  assert.equal(extractReasoningChunk(null), '');
  assert.equal(extractReasoningChunk({}), '');
  assert.equal(extractReasoningChunk({ content: 'not reasoning' }), '');
});

// ---------- splitInlineThink ----------

test('splitInlineThink: no tags → all content', () => {
  const r = splitInlineThink('Hello, world.');
  assert.equal(r.content, 'Hello, world.');
  assert.equal(r.reasoning, '');
  assert.equal(r.remainder, '');
});

test('splitInlineThink: one closed <think> block is routed to reasoning', () => {
  const r = splitInlineThink('before<think>secret plan</think>after');
  assert.equal(r.content, 'beforeafter');
  assert.equal(r.reasoning, 'secret plan');
  assert.equal(r.remainder, '');
});

test('splitInlineThink: unterminated <think> is held in remainder', () => {
  const r = splitInlineThink('visible<think>still thinking');
  assert.equal(r.content, 'visible');
  assert.equal(r.reasoning, '');
  assert.equal(r.remainder, '<think>still thinking');
});

test('splitInlineThink: multiple blocks', () => {
  const r = splitInlineThink('a<think>b</think>c<think>d</think>e');
  assert.equal(r.content, 'ace');
  assert.equal(r.reasoning, 'bd');
  assert.equal(r.remainder, '');
});

// ---------- sortToolCallsForExecution ----------

test('sortToolCallsForExecution: read_diagnostics runs last', () => {
  const calls = [
    { name: 'read_diagnostics', parsedArgs: {} },
    { name: 'search_replace', parsedArgs: {} },
    { name: 'replace_lines', parsedArgs: { start_line: 5 } }
  ];
  const sorted = sortToolCallsForExecution(calls);
  assert.equal(sorted[sorted.length - 1].name, 'read_diagnostics');
});

test('sortToolCallsForExecution: replace_lines ordered bottom-to-top', () => {
  const calls = [
    { name: 'replace_lines', parsedArgs: { start_line: 3 } },
    { name: 'replace_lines', parsedArgs: { start_line: 10 } },
    { name: 'replace_lines', parsedArgs: { start_line: 6 } }
  ];
  const sorted = sortToolCallsForExecution(calls);
  assert.deepEqual(sorted.map(c => c.parsedArgs.start_line), [10, 6, 3]);
});

test('sortToolCallsForExecution: non-edit tools keep relative order', () => {
  const calls = [
    { name: 'search_replace', parsedArgs: {} },
    { name: 'insert_at_cursor', parsedArgs: {} }
  ];
  const sorted = sortToolCallsForExecution(calls);
  assert.deepEqual(sorted.map(c => c.name), ['search_replace', 'insert_at_cursor']);
});

// ---------- sanitizeTitle ----------

test('sanitizeTitle: strips wrapping quotes and trailing punctuation', () => {
  assert.equal(sanitizeTitle('"A Short Plan."'), 'A Short Plan');
  assert.equal(sanitizeTitle('`Fix Lint Errors!`'), 'Fix Lint Errors');
});

test('sanitizeTitle: collapses whitespace', () => {
  assert.equal(sanitizeTitle('  hello    world  '), 'hello world');
});

test('sanitizeTitle: truncates long titles with ellipsis', () => {
  const long = 'word '.repeat(40).trim();
  const result = sanitizeTitle(long);
  assert.ok(result.length <= 61, 'within 60 chars + ellipsis');
  assert.ok(result.endsWith('…'));
});

test('sanitizeTitle: empty / nullish inputs', () => {
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle(null), '');
  assert.equal(sanitizeTitle(undefined), '');
});
