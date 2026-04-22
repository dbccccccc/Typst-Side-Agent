import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compactHistory, buildSystemMessage, buildMessages } from '../src/background/context.js';

// ---------- compactHistory ----------

test('compactHistory: no-op when under cap', () => {
  const msgs = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  assert.deepEqual(compactHistory(msgs, 10), msgs);
});

test('compactHistory: collapses older messages into a summary stub', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = compactHistory(msgs, 10);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.includes('summarised'));
  assert.ok(out.length < msgs.length);
  assert.equal(out[out.length - 1].content, 'm29', 'last recent message preserved');
});

test('compactHistory: keeps at least 8 recent messages even for tiny caps', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = compactHistory(msgs, 4);
  assert.ok(out.length - 1 >= 8, 'at least 8 recent messages kept');
});

// ---------- buildSystemMessage ----------

test('buildSystemMessage: uses default prompt when system prompt blank', () => {
  const msg = buildSystemMessage({
    settings: { systemPrompt: '' },
    attachments: {},
    modelConfig: null,
    customTools: [],
    mcpServers: []
  });
  assert.equal(msg.role, 'system');
  assert.ok(msg.content.includes('Typst Side Agent'));
});

test('buildSystemMessage: custom system prompt overrides default', () => {
  const msg = buildSystemMessage({
    settings: { systemPrompt: 'Be terse.' },
    attachments: {},
    modelConfig: null,
    customTools: [],
    mcpServers: []
  });
  assert.ok(msg.content.startsWith('Be terse.'));
});

test('buildSystemMessage: lists custom tool names under Extra tools', () => {
  const msg = buildSystemMessage({
    settings: {},
    attachments: {},
    modelConfig: null,
    customTools: [{ name: 'search_arxiv' }, { name: 'fetch_url' }],
    mcpServers: []
  });
  assert.ok(msg.content.includes('search_arxiv'));
  assert.ok(msg.content.includes('fetch_url'));
});

test('buildSystemMessage: MCP section shows namespace format', () => {
  const msg = buildSystemMessage({
    settings: {},
    attachments: {},
    modelConfig: null,
    customTools: [],
    mcpServers: [{ id: 'a', name: 'fs', toolNames: ['read', 'write'] }]
  });
  assert.ok(msg.content.includes('mcp__<server>__<tool>'));
  assert.ok(msg.content.includes('fs'));
});

test('buildSystemMessage: mentions vision fallback when previews attached but model lacks vision', () => {
  const msg = buildSystemMessage({
    settings: {},
    attachments: { previews: [{ dataUrl: 'data:image/png;base64,AAA' }] },
    modelConfig: { supportsVision: false },
    customTools: [],
    mcpServers: []
  });
  assert.ok(msg.content.includes('does not support vision'));
});

test('buildSystemMessage: includes selections', () => {
  const msg = buildSystemMessage({
    settings: {},
    attachments: { selections: [{ selectedText: 'let x = 1' }] },
    modelConfig: null,
    customTools: [],
    mcpServers: []
  });
  assert.ok(msg.content.includes('Selected text'));
  assert.ok(msg.content.includes('let x = 1'));
});

// ---------- buildMessages ----------

test('buildMessages: vision-enabled prepends image user message', () => {
  const sysMsg = { role: 'system', content: 'x' };
  const msgs = buildMessages({
    systemMessage: sysMsg,
    attachments: { previews: [{ dataUrl: 'data:image/png;base64,AAA' }] },
    modelConfig: { supportsVision: true },
    chatMessages: [{ role: 'user', content: 'hi' }],
    maxHistoryMessages: 40
  });
  assert.equal(msgs[0], sysMsg);
  assert.equal(msgs[1].role, 'user');
  assert.ok(Array.isArray(msgs[1].content));
  assert.equal(msgs[1].content[1].type, 'image_url');
});

test('buildMessages: non-vision model drops image content entirely', () => {
  const sysMsg = { role: 'system', content: 'x' };
  const msgs = buildMessages({
    systemMessage: sysMsg,
    attachments: { previews: [{ dataUrl: 'data:image/png;base64,AAA' }] },
    modelConfig: { supportsVision: false },
    chatMessages: [{ role: 'user', content: 'hi' }],
    maxHistoryMessages: 40
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, 'hi');
});

test('buildMessages: strips UI-only fields from assistant messages', () => {
  const msgs = buildMessages({
    systemMessage: { role: 'system', content: 'x' },
    attachments: {},
    modelConfig: null,
    chatMessages: [
      { role: 'user', content: 'hi', attachments: { preview: {} } },
      { role: 'assistant', content: 'yo', reasoning: 'hidden', _uiFlag: true }
    ],
    maxHistoryMessages: 40
  });
  assert.equal(msgs[1].role, 'user');
  assert.deepEqual(Object.keys(msgs[1]).sort(), ['content', 'role']);
  assert.equal(msgs[2].reasoning, undefined);
  assert.equal(msgs[2].reasoning_content, 'hidden');
  assert.equal(msgs[2]._uiFlag, undefined);
});

test('buildMessages: thinking model + tool_calls without stored reasoning sends empty reasoning_content', () => {
  const msgs = buildMessages({
    systemMessage: { role: 'system', content: 'x' },
    attachments: {},
    modelConfig: { reasoningEffort: 'high' },
    chatMessages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_diagnostics', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{}' }
    ],
    maxHistoryMessages: 40
  });
  const assistant = msgs.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(assistant);
  assert.equal(assistant.reasoning_content, '');
});

test('buildMessages: default reasoning effort does not inject empty reasoning_content for tool_calls', () => {
  const msgs = buildMessages({
    systemMessage: { role: 'system', content: 'x' },
    attachments: {},
    modelConfig: { reasoningEffort: 'default' },
    chatMessages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_diagnostics', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{}' }
    ],
    maxHistoryMessages: 40
  });
  const assistant = msgs.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(assistant);
  assert.equal(assistant.reasoning_content, undefined);
});
