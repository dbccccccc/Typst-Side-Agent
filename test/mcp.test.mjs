import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMcpContent } from '../src/background/mcp.js';

test('renderMcpContent: joins text items with newlines', () => {
  const r = renderMcpContent({ content: [
    { type: 'text', text: 'hello' },
    { type: 'text', text: 'world' }
  ]});
  assert.equal(r, 'hello\nworld');
});

test('renderMcpContent: extracts nested resource.text', () => {
  const r = renderMcpContent({ content: [
    { type: 'resource', resource: { text: 'file body' } }
  ]});
  assert.equal(r, 'file body');
});

test('renderMcpContent: serialises unknown item shapes as JSON', () => {
  const r = renderMcpContent({ content: [
    { type: 'image', data: 'AAA' }
  ]});
  assert.equal(r, '{"type":"image","data":"AAA"}');
});

test('renderMcpContent: nullish inputs return empty string', () => {
  assert.equal(renderMcpContent(null), '');
  assert.equal(renderMcpContent(undefined), '');
});

test('renderMcpContent: object without `content` array is JSON-serialised', () => {
  // Fallback branch: we hand the raw payload back as JSON so the model still
  // sees something, even when the server did not follow the spec shape.
  assert.equal(renderMcpContent({ note: 'hi' }), '{"note":"hi"}');
});

test('renderMcpContent: string input is returned verbatim', () => {
  assert.equal(renderMcpContent('already a string'), 'already a string');
});
