import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, PROTOCOL, validateEnvelope } from '../src/shared/protocol.js';
import { isQuickAttachForPanel, quickAttachSource } from '../src/shared/quick-attach.js';

test('quick attachments carry and enforce their exact originating tab and window', () => {
  const payload = quickAttachSource({ tab: { id: 17, windowId: 3 } });
  assert.deepEqual(payload, { tabId: 17, windowId: 3 });
  assert.equal(quickAttachSource({ tab: { id: 17 } }), null);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.QUICK_ATTACH_SELECTION, payload)).ok, true);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW, { tabId: 17, windowId: -1 })).error.code, 'INVALID_QUICK_ATTACH_SOURCE');
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.QUICK_ATTACH_SELECTION, { ...payload, eventId: 'quick-1' })).ok, true);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.QUICK_ATTACH_DRAIN, { windowId: 3 })).ok, true);
  assert.equal(validateEnvelope(buildRequest(PROTOCOL.QUICK_ATTACH_DRAIN, { windowId: -1 })).error.code, 'INVALID_WINDOW_ID');

  const panel = { activeTabId: 17, activeWindowId: 3 };
  assert.equal(isQuickAttachForPanel(panel, payload), true);
  assert.equal(isQuickAttachForPanel({ ...panel, activeTabId: 18 }, payload), false);
  assert.equal(isQuickAttachForPanel({ ...panel, activeWindowId: 4 }, payload), false);
});
