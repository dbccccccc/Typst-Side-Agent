import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSendController } from '../src/sidepanel/send-controller.js';
import { createTransitionCoordinator } from '../src/sidepanel/transition-coordinator.js';
import { createRunUiController } from '../src/sidepanel/run-ui-controller.js';
import { createAttachmentController } from '../src/sidepanel/attachment-controller.js';
import { PROTOCOL } from '../src/shared/protocol.js';

const ACTIVE_FILE = { projectLabel: 'Project', relativePath: 'main.typ', basename: 'main.typ', source: 'header_breadcrumb', confidence: 'high' };

function harness({ responses = {}, tabs = null, text = 'hello', model = { id: 'm', apiBaseUrl: 'https://model.example/v1', apiKey: 'k', modelId: 'x' } } = {}) {
  const state = {
    activeTabOnTypst: true,
    activeTabId: 7,
    activeWindowId: 1,
    currentProjectId: 'project',
    currentSession: { id: 'session', projectId: 'project' },
    chatHistory: [],
    isStreaming: false,
    activeRun: null,
    settings: { models: [model], activeModelId: 'm', maxHistoryMessages: 40 },
    attachments: { selections: [], previews: [] },
    stream: {}
  };
  const requests = [];
  const calls = [];
  const transitions = createTransitionCoordinator();
  const runUiController = createRunUiController({ state });
  const attachmentController = createAttachmentController({ state, request: async () => ({}), makeId: () => 'id' });
  const tabQueue = tabs ? [...tabs] : null;
  const view = Object.fromEntries([
    'setStatus', 'renderUserMessage', 'clearComposer', 'scrollToBottom', 'updateComposerLockState', 'setSendButtonStop',
    'finalizeStream', 'failStream', 'onStreamFinalize'
  ].map(name => [name, (...args) => { calls.push([name, ...args]); }]));
  view.readComposerText = () => text;
  view.createStreamingMessage = () => { calls.push(['createStreamingMessage']); return { messageEl: { tag: 'group' }, bodyEl: { tag: 'body' } }; };
  view.refreshLiveAttachments = async () => { calls.push(['refreshLiveAttachments']); };
  view.maybeAutoNameSession = async () => { calls.push(['maybeAutoNameSession']); };
  const controller = createSendController({
    state,
    request: async message => {
      requests.push(message);
      const handler = responses[message.type];
      return typeof handler === 'function' ? handler(message) : handler ?? { ok: true };
    },
    transitions,
    runUiController,
    attachmentController,
    queryActiveTab: async () => (tabQueue ? tabQueue.shift() : { id: 7, url: 'https://typst.app/project/project' }),
    projectIdFromTab: tab => tab?.url?.match(/typst\.app\/project\/([^/?#]+)/)?.[1] || null,
    getActiveModel: () => state.settings.models[0] || null,
    createRunId: () => 'run-1',
    saveSessionSnapshot: async (sessionId, messages) => { calls.push(['saveSessionSnapshot', sessionId, messages.length]); },
    view,
    resetStream: () => { state.stream = { messageEl: null, bodyEl: null }; }
  });
  return { state, requests, calls, transitions, runUiController, controller, view };
}

const types = requests => requests.map(message => message.type);

test('a send captures identity, reserves, saves the user turn, then starts the run', async () => {
  const { state, requests, calls, controller } = harness({
    responses: { [PROTOCOL.GET_EDITOR_CONTEXT]: { workspace: { active_editor_file: ACTIVE_FILE } } }
  });
  await controller.send();
  assert.deepEqual(types(requests), [PROTOCOL.GET_EDITOR_CONTEXT, PROTOCOL.AI_RUN_RESERVE, PROTOCOL.AI_STREAM_START]);
  assert.deepEqual(requests[1], { type: PROTOCOL.AI_RUN_RESERVE, runId: 'run-1', tabId: 7, projectId: 'project', sessionId: 'session' });
  assert.equal(requests[2].runId, 'run-1');
  assert.equal(requests[2].messages, state.chatHistory, 'the captured history object is dispatched');
  assert.deepEqual(requests[2].activeEditorFile, ACTIVE_FILE);
  assert.deepEqual(state.chatHistory, [{ role: 'user', content: 'hello', activeEditorFile: ACTIVE_FILE }]);
  assert.equal(state.isStreaming, true);
  assert.equal(state.activeRun?.runId, 'run-1');
  assert.deepEqual(state.stream, { messageEl: { tag: 'group' }, bodyEl: { tag: 'body' } });
  const order = calls.map(call => call[0]);
  const saveIndex = order.indexOf('saveSessionSnapshot');
  assert.ok(order.indexOf('renderUserMessage') < order.indexOf('createStreamingMessage'));
  assert.ok(order.indexOf('createStreamingMessage') < saveIndex, 'the UI starts streaming before the durable save');
  assert.ok(saveIndex < order.indexOf('maybeAutoNameSession'));
  assert.ok(calls.some(call => call[0] === 'setSendButtonStop' && call[1] === true));
});

test('an unidentifiable file or a missing model stops before anything is reserved', async () => {
  const unknownFile = harness({ responses: { [PROTOCOL.GET_EDITOR_CONTEXT]: { workspace: {} } } });
  await unknownFile.controller.send();
  assert.deepEqual(types(unknownFile.requests), [PROTOCOL.GET_EDITOR_CONTEXT]);
  assert.equal(unknownFile.state.chatHistory.length, 0);
  assert.ok(unknownFile.calls.some(call => call[0] === 'setStatus' && /could not be identified/.test(call[1]) && call[2] === true));
  assert.equal(unknownFile.transitions.hasActiveSend(), false);

  const noModel = harness({ model: undefined });
  noModel.state.settings.models = [];
  await noModel.controller.send();
  assert.deepEqual(noModel.requests, []);
  assert.deepEqual(noModel.calls, [['setStatus', 'Add a model in Settings first', true]]);
});

test('a tab or chat change between capture and confirmation sends nothing', async () => {
  const { state, requests, calls, controller } = harness({
    responses: { [PROTOCOL.GET_EDITOR_CONTEXT]: { workspace: { active_editor_file: ACTIVE_FILE } } },
    tabs: [{ id: 7, url: 'https://typst.app/project/project' }, { id: 9, url: 'https://typst.app/project/other' }]
  });
  await controller.send();
  assert.deepEqual(types(requests), [PROTOCOL.GET_EDITOR_CONTEXT]);
  assert.equal(state.chatHistory.length, 0);
  assert.equal(state.isStreaming, false);
  assert.ok(calls.some(call => call[0] === 'setStatus' && /changed while preparing/.test(call[1])));
});

test('a Stop issued before dispatch settles the run without starting it', async () => {
  // Stop while the user turn is being saved: the reserved run must never start.
  const stopDuringSave = harness({ responses: { [PROTOCOL.GET_EDITOR_CONTEXT]: { workspace: { active_editor_file: ACTIVE_FILE } } } });
  const controller = createSendController({
    state: stopDuringSave.state,
    request: async message => { stopDuringSave.requests.push(message); return message.type === PROTOCOL.GET_EDITOR_CONTEXT ? { workspace: { active_editor_file: ACTIVE_FILE } } : { ok: true }; },
    transitions: stopDuringSave.transitions,
    runUiController: stopDuringSave.runUiController,
    attachmentController: createAttachmentController({ state: stopDuringSave.state, request: async () => ({}), makeId: () => 'id' }),
    queryActiveTab: async () => ({ id: 7, url: 'https://typst.app/project/project' }),
    projectIdFromTab: () => 'project',
    getActiveModel: () => ({ id: 'm' }),
    createRunId: () => 'run-2',
    saveSessionSnapshot: async () => { stopDuringSave.transitions.cancelRun('run-2'); },
    view: stopDuringSave.view,
    resetStream: () => { stopDuringSave.state.stream = {}; }
  });
  await controller.send();
  assert.deepEqual(types(stopDuringSave.requests), [PROTOCOL.GET_EDITOR_CONTEXT, PROTOCOL.AI_RUN_RESERVE]);
  assert.ok(stopDuringSave.calls.some(call => call[0] === 'finalizeStream' && call[2]?.responseStatus === 'incomplete'));
  assert.ok(stopDuringSave.calls.some(call => call[0] === 'setStatus' && call[1] === 'Stopped'));
  assert.equal(stopDuringSave.state.activeRun, null);
  assert.equal(stopDuringSave.transitions.hasActiveSend(), false);
});

test('a rejected start fails the stream and settles the run; a thrown start also cancels it', async () => {
  const rejected = harness({ responses: {
    [PROTOCOL.GET_EDITOR_CONTEXT]: { workspace: { active_editor_file: ACTIVE_FILE } },
    [PROTOCOL.AI_STREAM_START]: { ok: false, error: 'Model missing' }
  } });
  await rejected.controller.send();
  await new Promise(resolve => { setTimeout(resolve, 0); });
  assert.ok(rejected.calls.some(call => call[0] === 'failStream' && call[1] === 'Model missing'));
  assert.equal(rejected.state.activeRun, null);

  const thrown = harness({ responses: {
    [PROTOCOL.GET_EDITOR_CONTEXT]: { workspace: { active_editor_file: ACTIVE_FILE } },
    [PROTOCOL.AI_STREAM_START]: () => { throw new Error('worker gone'); }
  } });
  await thrown.controller.send();
  await new Promise(resolve => { setTimeout(resolve, 0); });
  assert.deepEqual(types(thrown.requests).slice(-2), [PROTOCOL.AI_STREAM_START, PROTOCOL.AI_STREAM_CANCEL]);
  assert.ok(thrown.calls.some(call => call[0] === 'failStream' && call[1] === 'worker gone'));
});

test('sending while streaming requests cancellation of the active run', async () => {
  const { state, requests, controller, runUiController, transitions } = harness();
  const run = runUiController.begin({ runId: 'run-live', tabId: 7, projectId: 'project', sessionId: 'session', history: [] });
  state.isStreaming = true;
  transitions.beginSend({ projectId: 'project', sessionId: 'session', history: [] });
  await controller.send();
  assert.deepEqual(requests, [{ type: PROTOCOL.AI_STREAM_CANCEL, runId: 'run-live' }]);
  assert.equal(state.activeRun, run);
});

test('the controller refuses to start without a complete project and chat scope', async () => {
  const { state, requests, controller } = harness();
  state.currentSession = { id: 'session', projectId: 'another-project' };
  await controller.send();
  assert.deepEqual(requests, []);
});
