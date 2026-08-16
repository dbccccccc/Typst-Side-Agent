import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abortRun, configureAgentAdapters, generateSessionTitle, getActiveRunIds, handleStreamStart, reserveRun,
  resetAgentAdapters, resolveApproval, resolvePreflight
} from '../src/background/agent.js';
import { PROTOCOL, buildRequest, successResponse } from '../src/shared/protocol.js';
import { LIMITS } from '../src/shared/constants.js';
import { deferred, sseResponse } from './helpers/fakes.mjs';
import { mcpVisibleName } from '../src/shared/trust-policy.js';

afterEach(() => resetAgentAdapters());

test('session title requests reject redirects', async () => {
  let options;
  configureAgentAdapters({
    fetchImpl: async (_url, requestOptions) => {
      options = requestOptions;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A title' } }] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  assert.equal(await generateSessionTitle(
    { apiBaseUrl: 'https://model.example/v1', apiKey: 'fixture-key', modelId: 'fixture-model' },
    [{ role: 'user', content: 'hello' }]
  ), 'A title');
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(options.body);
  assert.equal(body.stream, false);
  assert.equal('temperature' in body, false);
  assert.equal('max_tokens' in body, false);
  assert.equal('max_completion_tokens' in body, false);
});

test('session titles support reasoning-model final content without exposing reasoning', async () => {
  let body;
  configureAgentAdapters({
    fetchImpl: async (_url, requestOptions) => {
      body = JSON.parse(requestOptions.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            reasoning_content: 'Private provider reasoning',
            content: [
              { type: 'reasoning', text: 'Private content-array reasoning' },
              { type: 'text', text: '<think>Private inline reasoning</think>"Reasoned document title."' }
            ]
          }
        }]
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  });

  assert.equal(await generateSessionTitle(
    {
      apiBaseUrl: 'https://model.example/v1', apiKey: 'fixture-key', modelId: 'fixture-reasoner',
      reasoningEffort: 'high'
    },
    [{ role: 'user', content: 'Improve the document hierarchy' }]
  ), 'Reasoned document title');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal('temperature' in body, false);
  assert.equal('max_tokens' in body, false);
  assert.equal(JSON.stringify(body).includes('Private'), false);
});

test('session title prompt preserves the latest user language instead of defaulting to English', async () => {
  let body;
  configureAgentAdapters({
    fetchImpl: async (_url, requestOptions) => {
      body = JSON.parse(requestOptions.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '翻译为英文' } }] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  assert.equal(await generateSessionTitle(
    { apiBaseUrl: 'https://model.example/v1', apiKey: 'fixture-key', modelId: 'fixture-model' },
    [
      { role: 'user', content: 'Review this document' },
      { role: 'assistant', content: 'I reviewed it.' },
      { role: 'user', content: '把这篇文档翻译成英文' }
    ]
  ), '翻译为英文');
  assert.match(body.messages[0].content, /language used by the most recent User entry/i);
  assert.match(body.messages[0].content, /Do not default to English/i);
  assert.match(body.messages[1].content, /把这篇文档翻译成英文/);
});

test('session titles use only message content and never substitute other response fields', async () => {
  configureAgentAdapters({
    fetchImpl: async () => new Response(JSON.stringify({
      output_text: 'Responses API fallback title',
      choices: [{
        text: 'Legacy completion fallback title',
        message: { reasoning_content: 'Secret chain of thought', content: null }
      }]
    }), { headers: { 'Content-Type': 'application/json' } })
  });

  await assert.rejects(generateSessionTitle(
    { apiBaseUrl: 'https://model.example/v1', apiKey: 'fixture-key', modelId: 'fixture-reasoner' },
    [{ role: 'user', content: 'Improve the document hierarchy' }]
  ), error => error.code === 'TITLE_EMPTY' && !error.message.includes('Secret'));
});

test('a provider cannot reuse a tool-call id in a later round', async () => {
  let round = 0;
  configureAgentAdapters({
    runtimeSend: () => {},
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      round += 1;
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'reused-call', function: { name: 'read_typst_docs', arguments: '{}' }
        }] } }] })}\n`,
        'data: [DONE]\n\n'
      ]);
    }
  });
  const result = await handleStreamStart(startMessage('run-duplicate-call'));
  assert.equal(round, 2);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DUPLICATE_TOOL_CALL_ID');
});

function startMessage(runId, overrides = {}) {
  const payload = {
    tabId: overrides.tabId ?? 17,
    projectId: overrides.projectId || 'project-a',
    sessionId: overrides.sessionId || 'session-a',
    messages: overrides.messages || [{ role: 'user', content: 'hello' }],
    settings: { maxHistoryMessages: 40, ...(overrides.settings || {}) },
    modelConfig: overrides.modelConfig || { apiBaseUrl: 'https://model.example/v1', apiKey: 'fixture-key', modelId: runId },
    attachments: overrides.attachments || {},
    ...(overrides.activeEditorFile ? { activeEditorFile: overrides.activeEditorFile } : {})
  };
  reserveRun(buildRequest(PROTOCOL.AI_RUN_RESERVE, {
    tabId: payload.tabId,
    projectId: payload.projectId,
    sessionId: payload.sessionId
  }, { requestId: `reserve-${runId}`, runId }));
  return buildRequest(PROTOCOL.AI_STREAM_START, payload, { requestId: `request-${runId}`, runId });
}

function textStream(text) {
  return sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`,
    'data: [DONE]\n\n'
  ]);
}

function createCheckpointAdapters(log = {}) {
  log.stages ||= [];
  log.updates ||= [];
  log.commits ||= [];
  log.rollbacks ||= [];
  let current = null;
  return {
    stageEditCheckpoint: async input => {
      log.stages.push(structuredClone(input));
      current = { ...input, status: 'prepared', fileLabel: input.fileLabel || 'current Typst document', createdAt: 100 };
      return current;
    },
    prepareEditCheckpointUpdate: async (id, pending) => {
      log.updates.push({ id, ...structuredClone(pending) });
      current = { ...current, ...pending, id, status: 'prepared' };
      return current;
    },
    commitEditCheckpoint: async id => {
      log.commits.push(id);
      current = { ...current, id, status: 'applied' };
      return { id, status: 'applied', fileLabel: current.fileLabel, createdAt: current.createdAt };
    },
    rollbackEditCheckpointPreparation: async id => {
      log.rollbacks.push(id);
      return { ok: true };
    }
  };
}

test('one complete run emits ordered, run-scoped batch and terminal events', async () => {
  const events = [];
  let persisted = null;
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    persistRunTranscript: async transcript => { persisted = transcript; },
    fetchImpl: async () => textStream('hello world')
  });
  const result = await handleStreamStart(startMessage('run-one'));
  assert.deepEqual(result, { ok: true, runId: 'run-one' });
  assert.deepEqual(events.map(event => event.type), [PROTOCOL.AI_STREAM_BATCH, PROTOCOL.AI_STREAM_DONE]);
  assert.ok(events.every(event => event.runId === 'run-one'));
  assert.equal(events[0].payload.items[0].text, 'hello world');
  assert.equal(persisted.sessionId, 'session-a');
  assert.equal(persisted.entry.content, 'hello world');
  assert.deepEqual(persisted.entry.segments, [{ type: 'text', content: 'hello world' }]);
  assert.equal(persisted.entry.responseStatus, 'complete');
  assert.deepEqual(getActiveRunIds(), []);
});

test('every sent message gives the model the active breadcrumb file as untrusted context', async () => {
  let providerBody;
  const activeEditorFile = {
    projectLabel: 'test', relativePath: 'references/ref.bib', basename: 'ref.bib',
    source: 'header_breadcrumb', confidence: 'high'
  };
  configureAgentAdapters({
    documentSnapshotsEnabled: () => false,
    runtimeSend: () => {},
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async () => { throw new Error('The run should use the file identity captured by the send action.'); },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    persistRunTranscript: async () => {},
    fetchImpl: async (_url, options) => {
      providerBody = JSON.parse(options.body);
      return textStream('Done.');
    }
  });

  assert.equal((await handleStreamStart(startMessage('run-active-file-context', {
    activeEditorFile,
    messages: [{ role: 'user', content: 'hello', activeEditorFile }]
  }))).ok, true);
  assert.equal(providerBody.messages[0].role, 'system');
  assert.equal(providerBody.messages[0].content.includes('ref.bib'), false);
  assert.equal(providerBody.messages[1].role, 'user');
  assert.match(providerBody.messages[1].content, /UNTRUSTED PROJECT CONTEXT/);
  assert.match(providerBody.messages[1].content, /references\/ref\.bib/);
  assert.match(providerBody.messages[1].content, /following user message/i);
  assert.equal(providerBody.messages[2].content, 'hello');
});

test('read_file_structure waits for the Files sidebar and returns only its visible names and hierarchy', async () => {
  const events = [];
  const providerBodies = [];
  let providerRound = 0;
  let filesPanelOpen = false;
  const activeEditorFile = {
    projectLabel: 'test', relativePath: 'main.typ', basename: 'main.typ',
    source: 'header_breadcrumb', confidence: 'high'
  };
  const projectTree = {
    source: 'files_panel_dom',
    entries: [
      { path: '123', kind: 'folder', state: 'expanded' },
      { path: '123/not opened folder', kind: 'folder', state: 'collapsed' },
      { path: '123/456.typ', kind: 'file' },
      { path: 'mystery-row', kind: 'unknown' },
      { path: 'main.typ', kind: 'file' }
    ],
    truncated: false
  };
  configureAgentAdapters({
    documentSnapshotsEnabled: () => false,
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_PREFLIGHT_WAITING && message.payload.name === 'read_file_structure') {
        filesPanelOpen = true;
        queueMicrotask(() => resolvePreflight(message.runId, message.payload.callId, 'retry'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      assert.equal(message.type, PROTOCOL.PAGE_GET_CONTEXT);
      assert.equal(message.payload.projection, 'identity');
      return successResponse(message.requestId, {
        workspace: filesPanelOpen
          ? { files_panel_open: true, project_file_tree: projectTree }
          : { files_panel_open: false }
      }, message.runId);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    persistRunTranscript: async () => {},
    fetchImpl: async (_url, options) => {
      providerBodies.push(JSON.parse(options.body));
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
            index: 0, id: 'call-tree', function: { name: 'read_file_structure', arguments: '{}' }
          }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Structure read.');
    }
  });
  assert.equal((await handleStreamStart(startMessage('run-project-tree-tool', {
    activeEditorFile,
    messages: [{ role: 'user', content: 'Explain the structure', activeEditorFile }]
  }))).ok, true);
  assert.equal(JSON.stringify(providerBodies[0]).includes('123/456.typ'), false, 'tree is absent before the explicit tool result');
  const treeResult = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT && event.payload.name === 'read_file_structure')?.payload.result;
  assert.equal(treeResult.ok, true);
  assert.equal(treeResult.complete, false);
  assert.deepEqual(treeResult.collapsed_folders, ['123/not opened folder']);
  assert.deepEqual(treeResult.unknown_entries, ['mystery-row']);
  assert.match(treeResult.note, /could not be classified/i);
  assert.ok(treeResult.entries.some(entry => entry.path === '123/456.typ'));
  assert.match(JSON.stringify(providerBodies[1]), /123\/456\.typ/);
  assert.equal(events.filter(event => event.type === PROTOCOL.AI_TOOL_PREFLIGHT_WAITING).length, 1);
  assert.equal(events.filter(event => event.type === PROTOCOL.AI_TOOL_PREFLIGHT_READY).length, 1);
});

test('open_project_file waits for an exact text file and retargets later document reads', async () => {
  const events = [];
  const providerBodies = [];
  let providerRound = 0;
  let activePath = 'main.typ';
  const targetPath = 'chapters/intro.typ';
  const activeEditorFile = {
    projectLabel: 'test', relativePath: 'main.typ', basename: 'main.typ',
    source: 'header_breadcrumb', confidence: 'high'
  };
  const liveContext = () => ({
    numberedDocument: activePath === targetPath ? '  1|= Introduction' : '  1|= Main',
    docLength: activePath === targetPath ? 14 : 6,
    lineCount: 1,
    startLine: 1,
    endLine: 1,
    cursorLine: 1,
    cursorColumn: 1,
    cursorPos: 0,
    selectionFrom: 0,
    selectionTo: 0,
    selectedText: '',
    editorToken: 'editor-file-switch',
    workspace: { active_editor_file: {
      projectLabel: 'test', relativePath: activePath, basename: activePath.split('/').at(-1),
      source: 'header_breadcrumb', confidence: 'high'
    } }
  });
  configureAgentAdapters({
    documentSnapshotsEnabled: () => false,
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_PREFLIGHT_WAITING && message.payload.name === 'open_project_file') {
        activePath = targetPath;
        queueMicrotask(() => resolvePreflight(message.runId, message.payload.callId, 'retry'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      if (message.type === PROTOCOL.PAGE_GET_PROBE) {
        return successResponse(message.requestId, { editor: true }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) {
        return successResponse(message.requestId, liveContext(), message.runId);
      }
      throw new Error(`Unexpected page request: ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    persistRunTranscript: async () => {},
    fetchImpl: async (_url, options) => {
      providerBodies.push(JSON.parse(options.body));
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
            index: 0, id: 'call-open-file', function: { name: 'open_project_file', arguments: JSON.stringify({ path: targetPath }) }
          }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      if (providerRound === 2) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
            index: 0, id: 'call-read-open-file', function: { name: 'read_document', arguments: '{}' }
          }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Target file read.');
    }
  });

  assert.equal((await handleStreamStart(startMessage('run-open-project-file', {
    activeEditorFile,
    messages: [{ role: 'user', content: 'Read the introduction', activeEditorFile }]
  }))).ok, true);
  const openResult = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT && event.payload.name === 'open_project_file')?.payload.result;
  const readResult = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT && event.payload.name === 'read_document')?.payload.result;
  assert.deepEqual(openResult, {
    ok: true,
    active_file: targetPath,
    previous_file: 'main.typ',
    text_editor_accessible: true,
    usage: 'Subsequent read_document and editor tools in this response now target active_file.'
  });
  assert.equal(readResult.ok, true);
  assert.match(readResult.numbered_document, /= Introduction/);
  assert.match(JSON.stringify(providerBodies[1]), /chapters\/intro\.typ/);
  assert.equal(events.filter(event => event.type === PROTOCOL.AI_TOOL_PREFLIGHT_WAITING && event.payload.name === 'open_project_file').length, 1);
  assert.equal(events.filter(event => event.type === PROTOCOL.AI_TOOL_PREFLIGHT_READY).length, 1);
});

test('a successful full response replaces the automatic live-document snapshot', async () => {
  const events = [];
  const invalidations = [];
  const creates = [];
  configureAgentAdapters({
    documentSnapshotsEnabled: () => true,
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      assert.equal(message.type, PROTOCOL.PAGE_GET_CONTEXT);
      return successResponse(message.requestId, {
        fullText: '= Current',
        editorToken: 'editor-snapshot',
        workspace: { focused_element_file_hint: 'main.typ' }
      });
    },
    invalidateAutomaticDocumentSnapshots: async input => {
      invalidations.push(structuredClone(input));
      return 0;
    },
    createDocumentSnapshot: async input => {
      creates.push(structuredClone(input));
      return { snapshot: {
        id: 'snapshot-run', kind: 'automatic', projectId: input.projectId,
        fileLabel: input.fileLabel, title: 'After latest response', createdAt: 100,
        textLength: input.text.length, sessionId: input.sessionId
      } };
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    persistRunTranscript: async () => {},
    fetchImpl: async () => textStream('Complete.')
  });

  assert.equal((await handleStreamStart(startMessage('run-snapshot'))).ok, true);
  assert.equal(invalidations.length, 1);
  assert.equal(invalidations[0].fileLabel, 'main.typ');
  assert.deepEqual(creates, [{
    kind: 'automatic',
    projectId: 'project-a',
    sessionId: 'session-a',
    runId: 'run-snapshot',
    fileLabel: 'main.typ',
    text: '= Current'
  }]);
  const done = events.find(event => event.type === PROTOCOL.AI_STREAM_DONE);
  assert.equal(done.payload.snapshot.id, 'snapshot-run');
});

test('read_diagnostics waits for compiler settling and two matching reads', async () => {
  const events = [];
  const timerDelays = [];
  const timeline = [];
  let timerId = 0;
  let providerRound = 0;
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      if (message.type === PROTOCOL.PAGE_GET_PROBE) {
        return successResponse(message.requestId, { editor: true, improvePanel: true }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_GET_DIAGNOSTICS) {
        timeline.push('read-diagnostics');
        return successResponse(message.requestId, { diagnostics: [] }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    setTimeoutImpl: (callback, delay) => {
      const id = ++timerId;
      timerDelays.push(delay);
      queueMicrotask(() => {
        if (delay === LIMITS.DIAGNOSTICS_SETTLE_DELAY_MS) timeline.push('settled');
        callback();
      });
      return id;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-diagnostics', function: { name: 'read_diagnostics', arguments: '{}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Diagnostics checked.');
    }
  });

  const result = await handleStreamStart(startMessage('run-diagnostics'));
  assert.equal(result.ok, true);
  assert.ok(timerDelays.includes(LIMITS.DIAGNOSTICS_SETTLE_DELAY_MS));
  assert.ok(timerDelays.includes(LIMITS.DIAGNOSTICS_STABILITY_INTERVAL_MS));
  assert.ok(timeline.indexOf('settled') < timeline.indexOf('read-diagnostics'));
  assert.equal(timeline.filter(item => item === 'read-diagnostics').length, 2);
  const toolResult = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT);
  assert.equal(Object.hasOwn(toolResult.payload.result, 'delay_ms'), false);
});

test('read_diagnostics keeps polling while compiler diagnostics are changing', async () => {
  const events = [];
  let diagnosticRead = 0;
  let providerRound = 0;
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      if (message.type === PROTOCOL.PAGE_GET_PROBE) {
        return successResponse(message.requestId, { editor: true, improvePanel: true }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_GET_DIAGNOSTICS) {
        diagnosticRead += 1;
        const diagnostics = diagnosticRead === 1 ? [] : [{
          severity: 'error',
          message: 'Failed to parse BibLaTeX (expected comma)',
          line: null,
          column: null,
          kind: 'typst',
          original: null,
          suggestion: null
        }];
        return successResponse(message.requestId, { diagnostics, totalCount: diagnostics.length, truncated: false }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    setTimeoutImpl: callback => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-diagnostics-changing', function: { name: 'read_diagnostics', arguments: '{}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Diagnostics checked.');
    }
  });

  assert.equal((await handleStreamStart(startMessage('run-diagnostics-changing'))).ok, true);
  assert.equal(diagnosticRead, 3);
  const toolResult = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT);
  assert.equal(toolResult.payload.result.error_count, 1);
  assert.equal(toolResult.payload.result.diagnostics[0].line, null);
});

test('editor mutation waits for exact-run approval and targets the captured tab', async () => {
  const events = [];
  const tabMessages = [];
  let providerRound = 0;
  configureAgentAdapters({
    ...createCheckpointAdapters(),
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED) {
        assert.equal(resolveApproval('another-run', message.payload.callId, 'approve_once'), false);
        queueMicrotask(() => resolveApproval(message.runId, message.payload.callId, 'approve_once'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (tabId, message) => {
      tabMessages.push({ tabId, message });
      if (message.type === PROTOCOL.PAGE_GET_PROBE) return successResponse(message.requestId, { editor: true, selection: true, improvePanel: true }, message.runId);
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) {
        return successResponse(message.requestId, {
          fullText: '= Old',
          numberedFullText: '1|= Old',
          cursorPos: 0,
          selectionFrom: 0,
          selectionTo: 0,
          editorToken: 'editor-1',
          workspace: { focused_element_file_hint: 'main.typ' }
        }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_SHOW_EDIT_PREVIEW) {
        assert.equal(message.payload.callId, 'call-edit');
        assert.equal(message.payload.expectedFileLabel, 'main.typ');
        return successResponse(message.requestId, { result: { ok: true, shown: true } }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_APPLY_EDIT) {
        assert.equal(message.payload.expectedText, '= Old');
        assert.equal(message.payload.expectedEditorToken, 'editor-1');
        assert.equal(message.payload.expectedFileLabel, 'main.typ');
        assert.deepEqual(message.payload.changes, [{ from: 0, to: 5, insert: '= Fixed' }]);
        assert.equal(message.payload.reviewedDiff, true);
        return successResponse(message.requestId, { result: { ok: true, edits_applied: 1, reviewed_diff: true } }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW) {
        return successResponse(message.requestId, { result: { ok: true, cleared: true } }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-edit', function: { name: 'replace_lines', arguments: '{"start_line":1,"end_line":1,"new_content":"= Fixed"}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Applied.');
    }
  });
  const result = await handleStreamStart(startMessage('run-edit', { tabId: 41 }));
  assert.equal(result.ok, true);
  const approval = events.find(event => event.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED);
  assert.equal(approval.payload.preview.kind, 'unified-diff');
  assert.equal(approval.payload.preview.fileLabel, 'main.typ');
  assert.deepEqual(approval.payload.preview.hunks[0].rows.filter(row => row.kind !== 'context').map(row => [row.kind, row.text]), [
    ['delete', '= Old'],
    ['insert', '= Fixed']
  ]);
  assert.ok(events.some(event => event.type === PROTOCOL.AI_TOOL_RESULT && event.payload.result.ok));
  assert.ok(tabMessages.length >= 3);
  assert.ok(tabMessages.every(record => record.tabId === 41));
  assert.deepEqual(tabMessages.slice(-3).map(record => record.message.type), [
    PROTOCOL.PAGE_SHOW_EDIT_PREVIEW,
    PROTOCOL.PAGE_APPLY_EDIT,
    PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW
  ]);
});

test('auto-approved editor mode applies atomically without opening a review gate', async () => {
  const events = [];
  const pageTypes = [];
  let providerRound = 0;
  configureAgentAdapters({
    ...createCheckpointAdapters(),
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      pageTypes.push(message.type);
      if (message.type === PROTOCOL.PAGE_GET_PROBE) {
        return successResponse(message.requestId, { editor: true }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) {
        return successResponse(message.requestId, {
          fullText: '= Old',
          cursorPos: 0,
          selectionFrom: 0,
          selectionTo: 0,
          editorToken: 'editor-auto'
        }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_APPLY_EDIT) {
        assert.equal(message.payload.expectedText, '= Old');
        assert.equal(message.payload.expectedEditorToken, 'editor-auto');
        assert.equal(message.payload.expectedFileLabel, 'Current Typst document');
        assert.deepEqual(message.payload.changes, [{ from: 0, to: 5, insert: '= Auto' }]);
        assert.equal(message.payload.reviewedDiff, false);
        return successResponse(message.requestId, { result: { ok: true, edits_applied: 1 } }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-auto', function: { name: 'search_replace', arguments: '{"search":"= Old","replace":"= Auto"}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Applied automatically.');
    }
  });

  const result = await handleStreamStart(startMessage('run-auto', {
    tabId: 43,
    settings: { editorApprovalMode: 'auto' }
  }));
  assert.equal(result.ok, true);
  assert.equal(events.some(event => event.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED), false);
  assert.deepEqual(pageTypes, [
    PROTOCOL.PAGE_GET_CONTEXT,
    PROTOCOL.PAGE_GET_PROBE,
    PROTOCOL.PAGE_GET_CONTEXT,
    PROTOCOL.PAGE_APPLY_EDIT
  ]);
  assert.ok(events.some(event => event.type === PROTOCOL.AI_TOOL_RESULT && event.payload.result.ok));
});

test('a continued chat deletes the prior automatic snapshot when the agent changes the document', async () => {
  let currentText = '= Old';
  let providerRound = 0;
  const deletions = [];
  const creates = [];
  configureAgentAdapters({
    ...createCheckpointAdapters(),
    documentSnapshotsEnabled: () => true,
    runtimeSend: () => {},
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      if (message.type === PROTOCOL.PAGE_GET_PROBE) return successResponse(message.requestId, { editor: true }, message.runId);
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) return successResponse(message.requestId, {
        fullText: currentText,
        cursorPos: 0,
        selectionFrom: 0,
        selectionTo: 0,
        editorToken: 'editor-snapshot-edit',
        workspace: { focused_element_file_hint: 'main.typ' }
      }, message.runId);
      if (message.type === PROTOCOL.PAGE_APPLY_EDIT) {
        const change = message.payload.changes[0];
        currentText = currentText.slice(0, change.from) + change.insert + currentText.slice(change.to);
        return successResponse(message.requestId, { result: { ok: true, edits_applied: 1 } }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    invalidateAutomaticDocumentSnapshots: async () => 0,
    deleteAutomaticDocumentSnapshots: async input => {
      deletions.push(structuredClone(input));
      return 1;
    },
    createDocumentSnapshot: async input => {
      creates.push(structuredClone(input));
      return { snapshot: {
        id: 'snapshot-new', kind: 'automatic', projectId: input.projectId,
        fileLabel: input.fileLabel, title: 'After latest response', createdAt: 100,
        textLength: input.text.length, sessionId: input.sessionId
      } };
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    persistRunTranscript: async () => {},
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-change', function: { name: 'search_replace', arguments: '{"search":"= Old","replace":"= New"}' } }] } }] })}\n`,
        'data: [DONE]\n\n'
      ]);
      return textStream('Changed.');
    }
  });

  const result = await handleStreamStart(startMessage('run-snapshot-edit', { settings: { editorApprovalMode: 'auto' } }));
  assert.equal(result.ok, true);
  assert.equal(currentText, '= New');
  assert.deepEqual(deletions, [{ projectId: 'project-a', sessionId: 'session-a', fileLabel: 'main.typ' }]);
  assert.equal(creates.at(-1).text, '= New');
});

test('multiple editor writes in one run share one pre-run checkpoint', async () => {
  const events = [];
  const journal = {};
  let currentText = '= Old';
  let providerRound = 0;
  configureAgentAdapters({
    ...createCheckpointAdapters(journal),
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      if (message.type === PROTOCOL.PAGE_GET_PROBE) return successResponse(message.requestId, { editor: true }, message.runId);
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) {
        return successResponse(message.requestId, {
          fullText: currentText,
          cursorPos: 0,
          selectionFrom: 0,
          selectionTo: 0,
          editorToken: 'editor-multi',
          workspace: { focused_element_file_hint: 'main.typ' }
        }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_APPLY_EDIT) {
        assert.equal(message.payload.expectedText, currentText);
        assert.equal(message.payload.expectedFileLabel, 'main.typ');
        const change = message.payload.changes[0];
        currentText = currentText.slice(0, change.from) + change.insert + currentText.slice(change.to);
        return successResponse(message.requestId, { result: { ok: true, edits_applied: 1 } }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-first', function: { name: 'search_replace', arguments: '{"search":"= Old","replace":"= Mid"}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      if (providerRound === 2) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-second', function: { name: 'search_replace', arguments: '{"search":"= Mid","replace":"= Final"}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Applied both changes.');
    }
  });

  const result = await handleStreamStart(startMessage('run-multi-edit', { settings: { editorApprovalMode: 'auto' } }));
  assert.equal(result.ok, true);
  assert.equal(currentText, '= Final');
  assert.equal(journal.stages.length, 1);
  assert.equal(journal.stages[0].beforeText, '= Old');
  assert.equal(journal.updates.length, 1);
  assert.equal(journal.commits.length, 2);
  const checkpoints = events
    .filter(event => event.type === PROTOCOL.AI_TOOL_RESULT)
    .map(event => event.payload.result.editCheckpoint);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].id, checkpoints[1].id);
  assert.equal(checkpoints[1].status, 'applied');
});

test('rejecting an editor diff never sends an apply request', async () => {
  const events = [];
  const pageTypes = [];
  let providerRound = 0;
  configureAgentAdapters({
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED) {
        queueMicrotask(() => resolveApproval(message.runId, message.payload.callId, 'deny'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      pageTypes.push(message.type);
      if (message.type === PROTOCOL.PAGE_GET_PROBE) return successResponse(message.requestId, { editor: true }, message.runId);
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) {
        return successResponse(message.requestId, {
          fullText: 'old', cursorPos: 0, selectionFrom: 0, selectionTo: 0, editorToken: 'editor-1'
        }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_SHOW_EDIT_PREVIEW) {
        return successResponse(message.requestId, {
          result: { ok: true, shown: false, warning: 'Inline fixture preview is unavailable.' }
        }, message.runId);
      }
      if (message.type === PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW) {
        return successResponse(message.requestId, { result: { ok: true, cleared: true } }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-reject', function: { name: 'search_replace', arguments: '{"search":"old","replace":"new"}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Left unchanged.');
    }
  });
  const result = await handleStreamStart(startMessage('run-reject', { tabId: 42 }));
  assert.equal(result.ok, true);
  assert.equal(pageTypes.includes(PROTOCOL.PAGE_APPLY_EDIT), false);
  assert.equal(pageTypes.includes(PROTOCOL.PAGE_SHOW_EDIT_PREVIEW), true);
  assert.equal(pageTypes.at(-1), PROTOCOL.PAGE_CLEAR_EDIT_PREVIEW);
  const approval = events.find(event => event.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED);
  assert.equal(approval.payload.previewNotice, 'Inline fixture preview is unavailable.');
  const toolResult = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT);
  assert.equal(toolResult.payload.result.code, 'TOOL_DENIED');
});

test('cancelling one run during discovery does not cancel another run', async () => {
  const blockedDiscovery = deferred();
  const discoveryStarted = deferred();
  const events = [];
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: `https://typst.app/project/${tabId}` }),
    loadCustomTools: runIndependentTools,
    loadMcpServers: async () => [],
    fetchImpl: async (_url, options) => textStream(JSON.parse(options.body).model === 'run-b' ? 'B complete' : 'A')
  });
  let firstDiscovery = true;
  function runIndependentTools() {
    if (firstDiscovery) {
      firstDiscovery = false;
      discoveryStarted.resolve();
      return blockedDiscovery.promise;
    }
    return Promise.resolve([]);
  }
  const runA = handleStreamStart(startMessage('run-a', { tabId: 1 }));
  await discoveryStarted.promise;
  const runB = handleStreamStart(startMessage('run-b', { tabId: 2, sessionId: 'session-b' }));
  assert.equal(abortRun('run-a').found, true);
  const [a, b] = await Promise.all([runA, runB]);
  assert.equal(a.cancelled, true);
  assert.equal(b.ok, true);
  assert.ok(events.some(event => event.runId === 'run-a' && event.type === PROTOCOL.AI_STREAM_CANCELLED));
  assert.ok(events.some(event => event.runId === 'run-b' && event.type === PROTOCOL.AI_STREAM_DONE));
  assert.equal(abortRun('stale-run').found, false);
});

test('cancellation after reservation prevents all run discovery and provider effects', async () => {
  let tabs = 0;
  let providers = 0;
  let customTools = 0;
  let mcpServers = 0;
  const events = [];
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async () => { tabs += 1; return { id: 1, url: 'https://typst.app/project/project-a' }; },
    loadCustomTools: async () => { customTools += 1; return []; },
    loadMcpServers: async () => { mcpServers += 1; return []; },
    fetchImpl: async () => { providers += 1; return textStream('unexpected'); }
  });
  const message = startMessage('run-cancel-before-start');
  assert.equal(abortRun(message.runId).found, true);
  const result = await handleStreamStart(message);
  assert.equal(result.cancelled, true);
  assert.deepEqual({ tabs, providers, customTools, mcpServers }, { tabs: 0, providers: 0, customTools: 0, mcpServers: 0 });
  assert.equal(events.filter(event => event.type === PROTOCOL.AI_STREAM_CANCELLED).length, 1);
});

test('originating tab is revalidated and errors without contacting provider after navigation', async () => {
  let fetchCount = 0;
  const events = [];
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async () => ({ id: 9, url: 'https://example.com/' }),
    fetchImpl: async () => { fetchCount += 1; return textStream('no'); }
  });
  const result = await handleStreamStart(startMessage('run-invalid', { tabId: 9 }));
  assert.equal(result.code, 'INVALID_RUN_TAB');
  assert.equal(fetchCount, 0);
  assert.equal(events.at(-1).type, PROTOCOL.AI_STREAM_ERROR);
});

test('read_document paging and truncation run through the agent dispatch boundary', async () => {
  const events = [];
  const numberedFullText = Array.from({ length: 120 }, (_, index) => `${index + 1}|${'x'.repeat(80)}`).join('\n');
  let providerRound = 0;
  configureAgentAdapters({
    runtimeSend: message => events.push(message),
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      if (message.type === PROTOCOL.PAGE_GET_PROBE) return successResponse(message.requestId, { editor: true }, message.runId);
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) return successResponse(message.requestId, {
        fullText: numberedFullText.replace(/^\s*\d+\|/gm, ''),
        numberedFullText,
        docLength: numberedFullText.length,
        cursorLine: 1,
        cursorColumn: 1,
        workspace: null
      }, message.runId);
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read', function: { name: 'read_document', arguments: '{"start_line":10,"max_chars":4000}' } }] } }] })}\n`,
        'data: [DONE]\n\n'
      ]);
      return textStream('Read complete.');
    }
  });
  assert.equal((await handleStreamStart(startMessage('run-read'))).ok, true);
  const result = events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT).payload.result;
  assert.equal(result.ok, true);
  assert.equal(result.start_line, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.numbered_document.length <= 4100);
});

test('reads and edits pause until the user returns to the file open when the message was sent', async () => {
  const events = [];
  const pageTypes = [];
  const sentFile = {
    projectLabel: 'Project', relativePath: 'references/ref.bib', basename: 'ref.bib',
    source: 'header_breadcrumb', confidence: 'high'
  };
  let activePath = 'references/ref.bib';
  let currentText = '= Same';
  let providerRound = 0;
  let applyAttempts = 0;
  const workspace = () => ({ active_editor_file: {
    projectLabel: 'Project', relativePath: activePath, basename: 'ref.bib',
    source: 'header_breadcrumb', confidence: 'high'
  } });
  configureAgentAdapters({
    ...createCheckpointAdapters(),
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_PREFLIGHT_WAITING && message.payload.missing.some(item => item.startsWith('open file:'))) {
        activePath = 'references/ref.bib';
        queueMicrotask(() => resolvePreflight(message.runId, message.payload.callId, 'retry'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => {
      pageTypes.push(message.type);
      if (message.type === PROTOCOL.PAGE_GET_PROBE) return successResponse(message.requestId, { editor: true }, message.runId);
      if (message.type === PROTOCOL.PAGE_GET_CONTEXT) return successResponse(message.requestId, {
        fullText: currentText, numberedDocument: `1|${currentText}`, docLength: currentText.length, lineCount: 1,
        startLine: 1, endLine: 1, cursorLine: 1, cursorColumn: 1,
        cursorPos: 0, selectionFrom: 0, selectionTo: 0, selectedText: '',
        editorToken: 'shared-editor', workspace: workspace()
      }, message.runId);
      if (message.type === PROTOCOL.PAGE_APPLY_EDIT) {
        applyAttempts += 1;
        if (applyAttempts === 1) {
          activePath = 'last-moment/ref.bib';
          return successResponse(message.requestId, {
            result: {
              ok: false, code: 'STALE_EDIT_PREVIEW', staleReason: 'file',
              error: 'The focused file changed after this diff was prepared.'
            }
          }, message.runId);
        }
        const change = message.payload.changes[0];
        currentText = currentText.slice(0, change.from) + change.insert + currentText.slice(change.to);
        return successResponse(message.requestId, { result: { ok: true, edits_applied: 1 } }, message.runId);
      }
      throw new Error(`Unexpected page request ${message.type}`);
    },
    loadCustomTools: async () => [],
    loadMcpServers: async () => [],
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) {
        activePath = 'appendix/ref.bib';
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read-file', function: { name: 'read_document', arguments: '{}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      if (providerRound === 2) {
        activePath = 'notes/ref.bib';
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-edit-file', function: { name: 'search_replace', arguments: '{"search":"= Same","replace":"= Fixed"}' } }] } }] })}\n`,
          'data: [DONE]\n\n'
        ]);
      }
      return textStream('Applied after the original file was reopened.');
    }
  });

  assert.equal((await handleStreamStart(startMessage('run-file-switch', {
    settings: { editorApprovalMode: 'auto' },
    activeEditorFile: sentFile,
    messages: [{ role: 'user', content: 'Read and update this file', activeEditorFile: sentFile }]
  }))).ok, true);
  const results = events.filter(event => event.type === PROTOCOL.AI_TOOL_RESULT).map(event => event.payload.result);
  assert.equal(Object.hasOwn(results[0], 'active_file'), false);
  assert.equal(Object.hasOwn(results[0], 'workspace'), false);
  assert.equal(results[1].ok, true);
  assert.equal(currentText, '= Fixed');
  assert.equal(pageTypes.filter(type => type === PROTOCOL.PAGE_APPLY_EDIT).length, 2);
  const waits = events.filter(event => event.type === PROTOCOL.AI_TOOL_PREFLIGHT_WAITING && event.payload.missing.some(item => item.startsWith('open file:')));
  assert.equal(waits.length, 3);
  assert.ok(waits.every(event => event.payload.hint.includes('Return to references/ref.bib')));
  assert.equal(events.filter(event => event.type === PROTOCOL.AI_TOOL_PREFLIGHT_READY).length, 3);
});

test('custom HTTP dispatch cannot start until the exact run approves it', async () => {
  const events = [];
  let providerRound = 0;
  let customFetches = 0;
  let customRequestOptions;
  const longQuery = 'x'.repeat(2100);
  configureAgentAdapters({
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED) {
        assert.equal(customFetches, 0);
        queueMicrotask(() => resolveApproval(message.runId, message.payload.callId, 'approve_once'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => successResponse(message.requestId, { editor: true }, message.runId),
    loadCustomTools: async () => [{
      id: 'custom-1', name: 'lookup', description: 'Lookup fixture', endpoint: 'https://tool.example/call',
      headers: {}, parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, enabled: true
    }],
    loadMcpServers: async () => [],
    fetchImpl: async (url, options) => {
      if (url === 'https://tool.example/call') {
        customFetches += 1;
        customRequestOptions = options;
        return new Response('{"answer":42}', { headers: { 'Content-Type': 'application/json' } });
      }
      providerRound += 1;
      if (providerRound === 1) return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-custom', function: { name: 'lookup', arguments: JSON.stringify({ q: longQuery }) } }] } }] })}\n`,
        'data: [DONE]\n\n'
      ]);
      return textStream('Lookup complete.');
    }
  });
  assert.equal((await handleStreamStart(startMessage('run-custom'))).ok, true);
  assert.equal(customFetches, 1);
  assert.equal(customRequestOptions.redirect, 'error');
  const approval = events.find(event => event.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED);
  assert.equal(approval.payload.arguments.length, 2000);
  assert.equal(approval.payload.argumentsTruncated, true);
  assert.ok(approval.payload.argumentChars > approval.payload.arguments.length);
  assert.equal(events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT).payload.result.result.answer, 42);
});

test('MCP dispatch cannot start until the exact run approves it', async () => {
  const events = [];
  const server = { id: 'server-1', name: 'fixture', url: 'https://mcp.example/rpc', protocolMode: 'auto', headers: {}, enabled: true };
  const tool = { name: 'lookup', description: 'Lookup fixture', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
  const visibleName = mcpVisibleName(server, tool);
  let providerRound = 0;
  let mcpCalls = 0;
  configureAgentAdapters({
    runtimeSend: message => {
      events.push(message);
      if (message.type === PROTOCOL.AI_TOOL_APPROVAL_REQUIRED) {
        assert.equal(mcpCalls, 0);
        queueMicrotask(() => resolveApproval(message.runId, message.payload.callId, 'allow_run'));
      }
    },
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    tabsSend: async (_tabId, message) => successResponse(message.requestId, { editor: true }, message.runId),
    loadCustomTools: async () => [],
    loadMcpServers: async () => [server],
    listMcpToolsDetailed: async () => ({ tools: [tool], errors: [], pages: 1 }),
    callMcpTool: async () => { mcpCalls += 1; return { content: [{ type: 'text', text: 'mcp result' }] }; },
    fetchImpl: async () => {
      providerRound += 1;
      if (providerRound === 1) return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-mcp', function: { name: visibleName, arguments: '{"q":"typst"}' } }] } }] })}\n`,
        'data: [DONE]\n\n'
      ]);
      return textStream('MCP complete.');
    }
  });
  assert.equal((await handleStreamStart(startMessage('run-mcp'))).ok, true);
  assert.equal(mcpCalls, 1);
  assert.equal(events.find(event => event.type === PROTOCOL.AI_TOOL_RESULT).payload.result.content, 'mcp result');
});

test('legacy cleartext model consent is rejected before discovery or provider fetch', async () => {
  let fetches = 0;
  let discoveries = 0;
  configureAgentAdapters({
    runtimeSend: () => {},
    tabsGet: async tabId => ({ id: tabId, url: 'https://typst.app/project/project-a' }),
    loadCustomTools: async () => { discoveries += 1; return []; },
    loadMcpServers: async () => [],
    fetchImpl: async () => { fetches += 1; return textStream('unexpected'); }
  });
  const result = await handleStreamStart(startMessage('run-legacy-http', {
    modelConfig: {
      apiBaseUrl: 'http://192.168.1.5/v1', apiKey: 'fixture-key', modelId: 'legacy',
      insecureTransportAcknowledged: true
    }
  }));
  assert.equal(result.code, 'INSECURE_CONFIRMATION_REQUIRED');
  assert.equal(discoveries, 0);
  assert.equal(fetches, 0);
});
