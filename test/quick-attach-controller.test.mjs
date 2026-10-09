import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuickAttachController } from '../src/sidepanel/quick-attach-controller.js';
import { PROTOCOL } from '../src/shared/protocol.js';

function harness({ remote = [] } = {}) {
  const state = { activeWindowId: 4 };
  const delivered = [];
  const statuses = [];
  const requests = [];
  const controller = createQuickAttachController({
    state,
    request: async message => { requests.push(message); return remote; },
    deliver: async (type, source) => {
      if (source?.fail) throw new Error(`failed ${source.eventId}`);
      delivered.push([type, source.eventId]);
    },
    setStatus: (text, isError) => statuses.push([text, isError])
  });
  return { state, delivered, statuses, requests, controller };
}

test('events are held until the panel is ready, then delivered in order and deduplicated', async () => {
  const { controller, delivered, requests } = harness({ remote: [
    { type: PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW, payload: { tabId: 1, windowId: 4, eventId: 'remote-1' } },
    { type: PROTOCOL.QUICK_ATTACH_SELECTION, payload: { tabId: 1, windowId: 4, eventId: 'local-2' } },
    { type: 'UNRELATED', payload: { eventId: 'ignored' } }
  ] });
  assert.equal(controller.enqueue(PROTOCOL.QUICK_ATTACH_SELECTION, { tabId: 1, windowId: 4, eventId: 'local-1' }), true);
  assert.equal(controller.enqueue(PROTOCOL.QUICK_ATTACH_SELECTION, { tabId: 1, windowId: 4, eventId: 'local-2' }), true);
  assert.equal(controller.enqueue(PROTOCOL.QUICK_ATTACH_SELECTION, { tabId: 1, windowId: 4, eventId: 'local-1' }), false, 'duplicate id');
  assert.equal(controller.enqueue('UNRELATED', { eventId: 'x' }), false);
  assert.equal(controller.pendingCount(), 2);
  assert.deepEqual(delivered, []);

  const accepted = await controller.drain();
  await controller.settled();
  assert.equal(controller.isReady(), true);
  assert.deepEqual(requests, [{ type: PROTOCOL.QUICK_ATTACH_DRAIN, windowId: 4 }]);
  assert.equal(accepted, 3, 'two local plus one new remote event');
  assert.deepEqual(delivered, [
    [PROTOCOL.QUICK_ATTACH_SELECTION, 'local-1'],
    [PROTOCOL.QUICK_ATTACH_SELECTION, 'local-2'],
    [PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW, 'remote-1']
  ]);

  controller.enqueue(PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW, { tabId: 1, windowId: 4, eventId: 'late' });
  await controller.settled();
  assert.deepEqual(delivered.at(-1), [PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW, 'late']);
});

test('a failed delivery is reported and does not block later events', async () => {
  const { controller, delivered, statuses } = harness();
  await controller.drain();
  controller.enqueue(PROTOCOL.QUICK_ATTACH_SELECTION, { tabId: 1, windowId: 4, eventId: 'bad', fail: true });
  controller.enqueue(PROTOCOL.QUICK_ATTACH_SELECTION, { tabId: 1, windowId: 4, eventId: 'good' });
  await controller.settled();
  assert.deepEqual(statuses, [['failed bad', true]]);
  assert.deepEqual(delivered, [[PROTOCOL.QUICK_ATTACH_SELECTION, 'good']]);
});

test('draining without a known window skips the worker buffer', async () => {
  const { controller, state, requests } = harness();
  state.activeWindowId = null;
  assert.equal(await controller.drain(), 0);
  assert.deepEqual(requests, []);
});
