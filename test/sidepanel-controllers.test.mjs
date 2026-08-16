import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSnapshotDate } from '../src/sidepanel/snapshot-controller.js';
import { PROTOCOL } from '../src/shared/protocol.js';
import { createSessionController } from '../src/sidepanel/session-controller.js';
import { createAttachmentController } from '../src/sidepanel/attachment-controller.js';
import { createRunUiController } from '../src/sidepanel/run-ui-controller.js';
import { createModelRegistryController, createRecordRegistryController } from '../src/sidepanel/registry-controller.js';
import { createTransitionCoordinator } from '../src/sidepanel/transition-coordinator.js';
import { createStatusController } from '../src/sidepanel/status-controller.js';
import { deferred } from './helpers/fakes.mjs';

test('session controller owns commands and active history transitions', async () => {
  const requests = [];
  const state = { currentSession: null, chatHistory: [] };
  const controller = createSessionController({
    state,
    request: async message => { requests.push(message); return message; }
  });
  await controller.list('project');
  await controller.get('session');
  await controller.create('project');
  await controller.saveSnapshot('session', [{ role: 'user', content: 'hello' }]);
  await controller.removeProject('project');
  assert.deepEqual(requests.map(message => message.type), [
    PROTOCOL.SESSION_LIST,
    PROTOCOL.SESSION_GET,
    PROTOCOL.SESSION_CREATE,
    PROTOCOL.SESSION_UPDATE,
    PROTOCOL.SESSION_DELETE_BY_PROJECT
  ]);
  const source = { id: 'session', messages: [{ role: 'user', content: 'hello' }] };
  const active = controller.activate(source);
  assert.notEqual(active, source.messages);
  active.push({ role: 'assistant', content: 'local' });
  assert.equal(source.messages.length, 1);
  assert.equal(state.currentSession, source);
});

test('run UI controller rejects stale events and settles only the exact run', async () => {
  const state = { activeRun: null };
  const controller = createRunUiController({ state });
  const history = [];
  const run = controller.begin({ runId: 'run-a', tabId: 3, projectId: 'p', sessionId: 's', history });
  assert.equal(Object.isFrozen(run), true);
  assert.equal(controller.accepts({ type: PROTOCOL.AI_STREAM_BATCH, runId: 'run-b' }), false);
  assert.equal(controller.accepts({ type: PROTOCOL.AI_STREAM_BATCH, runId: 'run-a' }), true);
  assert.equal(controller.complete({ runId: 'run-a' }), false);
  assert.equal(controller.complete(run), true);
  await run.terminalPromise;
  assert.equal(controller.complete(run), false);
  assert.equal(state.activeRun, null);
});

test('transition coordinator provides single-flight sends and stale-navigation epochs', () => {
  const coordinator = createTransitionCoordinator();
  const history = [];
  const identity = { projectId: 'p', sessionId: 's', history };
  const send = coordinator.beginSend(identity);
  assert.ok(send);
  assert.equal(coordinator.beginSend(identity), null);
  assert.equal(coordinator.isSendCurrent(send, identity), true);
  assert.equal(coordinator.isSendCurrent(send, { ...identity, sessionId: 'other' }), false);
  assert.equal(coordinator.markReserved(send, 'run-a'), true);
  assert.equal(coordinator.canDispatch(send), true);
  assert.equal(coordinator.cancelRun('other'), false);
  assert.equal(coordinator.cancelRun('run-a'), true);
  assert.equal(coordinator.canDispatch(send), false);
  assert.equal(coordinator.endSend({}), false);
  assert.equal(coordinator.endSend(send), true);
  assert.ok(coordinator.beginSend(identity));

  const oldTab = coordinator.nextTabSync();
  const currentTab = coordinator.nextTabSync();
  assert.equal(coordinator.isTabSyncCurrent(oldTab), false);
  assert.equal(coordinator.isTabSyncCurrent(currentTab), true);
  const oldSession = coordinator.nextSessionSwitch();
  const currentSession = coordinator.nextSessionSwitch();
  assert.equal(coordinator.isSessionSwitchCurrent(oldSession), false);
  assert.equal(coordinator.isSessionSwitchCurrent(currentSession), true);
});

test('transition coordinator keeps cancellation sticky across reservation and start boundaries', () => {
  const coordinator = createTransitionCoordinator();
  const token = coordinator.beginSend({ projectId: 'p', sessionId: 's', history: [] });
  assert.equal(coordinator.cancelSend(token), true);
  assert.equal(coordinator.markReserved(token, 'run-a'), false);
  assert.equal(coordinator.markStarting(token), false);
  assert.equal(coordinator.isSendCurrent(token, token), false);
});

test('attachment controller owns selection/preview state, refresh, and minimized history', async () => {
  const state = { attachments: { selections: [], previews: [] } };
  let nextId = 0;
  const requests = [];
  const controller = createAttachmentController({
    state,
    makeId: () => `id-${++nextId}`,
    request: async message => {
      requests.push(message);
      return { dataUrl: 'data:image/png;base64,REFRESHED' };
    },
    thumbnailer: async () => ({ dataUrl: 'data:image/webp;base64,THUMB', width: 1, height: 1, mimeType: 'image/webp', thumbnail: true })
  });
  const activeFile = {
    projectLabel: 'test', relativePath: 'ref.bib', basename: 'ref.bib',
    source: 'header_breadcrumb', confidence: 'high'
  };
  const selection = controller.addSelection('  selected  ', activeFile);
  const preview = controller.addPreview({ dataUrl: 'data:image/png;base64,ORIGINAL', captureMode: 'canvas' });
  assert.deepEqual(controller.composePayload(), {
    selections: [{ selectedText: 'selected', activeFile }],
    previews: [{ dataUrl: 'data:image/png;base64,ORIGINAL' }]
  });
  await controller.refresh(9);
  assert.deepEqual(requests[0], { type: PROTOCOL.GET_PREVIEW, preferTypstCanvas: true, tabId: 9 });
  const history = await controller.buildHistorySnapshot(controller.composePayload());
  assert.equal(history.selections[0].fileLabel, 'ref.bib');
  assert.equal(history.previews[0].thumbnail, true);
  controller.removeSelection(selection.id);
  controller.removePreview(preview.id);
  assert.deepEqual(state.attachments, { selections: [], previews: [] });
  controller.clear();
  assert.deepEqual(state.attachments, { selections: [], previews: [] });
});

test('record registry persists before committing and leaves state unchanged on failure', async () => {
  let records = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }];
  let reject = false;
  const persisted = [];
  let stateObservedDuringPersist = null;
  const controller = createRecordRegistryController({
    getRecords: () => records,
    setRecords: next => { records = next; },
    persist: async next => {
      if (reject) throw new Error('save failed');
      stateObservedDuringPersist = records;
      persisted.push(next);
    }
  });
  await controller.toggle('a');
  assert.equal(records[0].enabled, false);
  assert.equal(stateObservedDuringPersist[0].enabled, true);
  assert.equal(records, persisted[0]);
  const before = records;
  reject = true;
  await assert.rejects(controller.remove('a'), /save failed/);
  assert.equal(records, before);
});

test('record registry serializes overlapping mutations without losing either update', async () => {
  let records = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }];
  const firstPersist = deferred();
  let persistCount = 0;
  const controller = createRecordRegistryController({
    getRecords: () => records,
    setRecords: next => { records = next; },
    persist: async () => {
      persistCount += 1;
      if (persistCount === 1) await firstPersist.promise;
    }
  });
  const first = controller.toggle('a');
  const second = controller.toggle('b');
  await Promise.resolve();
  assert.equal(persistCount, 1);
  firstPersist.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(records.map(record => [record.id, record.enabled]), [['a', false], ['b', true]]);
  assert.equal(persistCount, 2);
});

test('record registry upserts, replaces, and commits the worker-authoritative snapshot', async () => {
  let records = [{ id: 'a', name: 'old' }];
  const mutations = [];
  const controller = createRecordRegistryController({
    getRecords: () => records,
    setRecords: next => { records = next; },
    persist: async (next, mutation) => {
      mutations.push(mutation);
      return { records: next.map(record => ({ ...record, workerChecked: true })) };
    }
  });
  await controller.upsert({ id: 'a', name: 'updated' });
  await controller.upsert({ id: 'b', name: 'new' });
  await controller.replace([{ id: 'c', name: 'replacement' }]);
  assert.deepEqual(records, [{ id: 'c', name: 'replacement', workerChecked: true }]);
  assert.deepEqual(mutations.map(mutation => mutation.type), ['upsert', 'upsert', 'replace']);
});

test('model registry repairs active and auto-name references transactionally', async () => {
  let settings = {
    models: [{ id: 'a' }, { id: 'b' }],
    activeModelId: 'a',
    autoNameModelId: 'a',
    maxHistoryMessages: 40
  };
  const controller = createModelRegistryController({
    getSettings: () => settings,
    setSettings: next => { settings = next; },
    persist: async () => {}
  });
  await controller.remove('a');
  assert.deepEqual(settings.models, [{ id: 'b' }]);
  assert.equal(settings.activeModelId, 'b');
  assert.equal(settings.autoNameModelId, null);
  await controller.select('b');
  await assert.rejects(Promise.resolve().then(() => controller.select('missing')), /Unknown model/);
});

test('model registry upserts and replaces against authoritative worker settings', async () => {
  let settings = {
    models: [{ id: 'a', label: 'old' }],
    activeModelId: 'missing',
    autoNameModelId: 'missing'
  };
  const mutations = [];
  const controller = createModelRegistryController({
    getSettings: () => settings,
    setSettings: next => { settings = next; },
    persist: async (next, mutation) => {
      mutations.push(mutation);
      return { settings: { ...next, workerChecked: true } };
    }
  });
  await controller.upsert({ id: 'a', label: 'updated' });
  assert.equal(settings.models[0].label, 'updated');
  assert.equal(settings.activeModelId, 'a');
  await controller.upsert({ id: 'b', label: 'new' });
  await controller.replace([{ id: 'b', label: 'replacement' }], { activeModelId: 'b' });
  assert.deepEqual(settings.models, [{ id: 'b', label: 'replacement' }]);
  assert.equal(settings.workerChecked, true);
  assert.deepEqual(mutations.map(mutation => mutation.type), ['upsert', 'upsert', 'replace']);
});

test('snapshot timestamps use compact relative labels in the recovery popover', () => {
  const now = 10 * 60 * 60 * 1000;
  assert.equal(formatSnapshotDate(now - 20_000, now), 'Just now');
  assert.equal(formatSnapshotDate(now - 2 * 60_000, now), '2 min ago');
  assert.equal(formatSnapshotDate(now - 3 * 60 * 60_000, now), '3 hr ago');
});

test('status toast expires by severity, ignores stale timers, and copies its message', async () => {
  const timers = new Map();
  let nextTimer = 0;
  const copied = [];
  const makeElement = () => {
    const classes = new Set();
    return {
      textContent: '', title: '', offsetWidth: 1,
      classes,
      attributes: {},
      style: { setProperty(name, value) { this[name] = value; } },
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener() {}
    };
  };
  const elements = {
    status: makeElement(),
    'status-message': makeElement(),
    'status-copy': makeElement(),
    'status-close': makeElement()
  };
  const controller = createStatusController({
    documentRef: { getElementById: id => elements[id] || null },
    setTimer(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer() {},
    copyText: async text => { copied.push(text); },
    collapseDurationMs: 0
  });
  controller.set('older', false, 1000);
  const olderExpiry = timers.get(1).callback;
  controller.set('newer failure', true);
  olderExpiry();
  assert.equal(elements['status-message'].textContent, 'newer failure');
  assert.equal(elements.status.classes.has('is-error'), true);
  assert.equal(elements.status.attributes.role, 'alert');
  assert.equal(timers.get(2).delay, 7000);
  assert.equal(await controller.copy(), true);
  assert.deepEqual(copied, ['newer failure']);
  assert.equal(elements['status-copy'].classes.has('is-copied'), true);
  timers.get(2).callback();
  assert.equal(elements.status.classes.has('hidden'), true);
  assert.equal(elements.status.attributes['aria-hidden'], 'true');
});
