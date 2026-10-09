import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PROTOCOL } from '../src/shared/protocol.js';

const html = await readFile(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'chrome-extension://fixture/src/sidepanel/index.html' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.HTMLElement = window.HTMLElement;

const { createSnapshotController, formatSnapshotDate } = await import('../src/sidepanel/snapshot-controller.js');
const { renderEditDiffPreview } = await import('../src/sidepanel/edit-diff.js');

const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => { setTimeout(resolve, 0); });
};
const byId = id => document.getElementById(id);
const now = Date.now();

const automatic = { id: 'snap-1', kind: 'automatic', projectId: 'project', fileLabel: 'main.typ', title: 'After latest response', createdAt: now - 120_000, textLength: 1234, sessionId: 'session' };
const rescue = { id: 'snap-2', kind: 'rescue', projectId: 'project', fileLabel: 'main.typ', title: 'Before restore', createdAt: now - 7_200_000, textLength: 50 };
const preview = {
  kind: 'unified-diff', fileLabel: 'main.typ', additions: 1, deletions: 1,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
    { kind: 'delete', oldLine: 1, newLine: null, text: '= Current' },
    { kind: 'insert', oldLine: null, newLine: 1, text: '= Saved' }
  ] }]
};

const fake = {
  scope: { tabId: 7, projectId: 'project', sessionId: 'session' },
  locked: false,
  snapshots: [automatic, rescue],
  previewResult: () => ({ ok: true, snapshot: automatic, noChanges: false, preview }),
  requests: [],
  statuses: [],
  restored: []
};
const controller = createSnapshotController({
  request: async message => {
    fake.requests.push(message);
    switch (message.type) {
      case PROTOCOL.DOCUMENT_SNAPSHOT_LIST: return { ok: true, fileLabel: 'main.typ', snapshots: fake.snapshots };
      case PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW: return fake.previewResult();
      case PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE:
        return {
          ok: true, snapshot: automatic, noChanges: false, rescueSnapshot: rescue,
          editorStateUpdate: { kind: 'snapshot-restored', snapshotId: 'snap-1', fileLabel: 'main.typ', restoredAt: now }
        };
      case PROTOCOL.DOCUMENT_SNAPSHOT_DELETE:
        fake.snapshots = fake.snapshots.filter(snapshot => snapshot.id !== message.snapshotId);
        return { ok: true, removed: 1 };
      default: throw new Error(`unexpected ${message.type}`);
    }
  },
  getScope: () => fake.scope,
  isLocked: () => fake.locked,
  setStatus: (text, isError) => fake.statuses.push([text, !!isError]),
  renderDiff: renderEditDiffPreview,
  onRestored: async (update, scope) => { fake.restored.push([update, scope]); }
});
controller.init();

function trigger() {
  let button = byId('fixture-snapshot-trigger');
  if (!button) {
    button = document.createElement('button');
    button.id = 'fixture-snapshot-trigger';
    button.className = 'response-snapshot-button';
    byId('messages').appendChild(button);
  }
  return button;
}

function reset() {
  controller.reset();
  fake.scope = { tabId: 7, projectId: 'project', sessionId: 'session' };
  fake.locked = false;
  fake.snapshots = [automatic, rescue];
  fake.previewResult = () => ({ ok: true, snapshot: automatic, noChanges: false, preview });
  fake.requests.length = 0;
  fake.statuses.length = 0;
  fake.restored.length = 0;
}

test('the menu lists snapshots for the focused file with kind badges and closes on Escape', async () => {
  reset();
  const button = trigger();
  await controller.openFor(button);
  const menu = byId('snapshot-menu');
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(byId('snapshot-file').textContent, 'main.typ');
  assert.deepEqual(fake.requests.map(message => message.type), [PROTOCOL.DOCUMENT_SNAPSHOT_LIST]);
  assert.deepEqual(fake.requests[0], { type: PROTOCOL.DOCUMENT_SNAPSHOT_LIST, tabId: 7, projectId: 'project', sessionId: 'session' });
  const items = [...byId('snapshot-list').querySelectorAll('.snapshot-item')];
  assert.deepEqual(items.map(item => item.querySelector('strong').textContent), ['After latest response', 'Before restore']);
  assert.deepEqual(items.map(item => item.querySelector('.snapshot-kind').textContent), ['Response', 'Recovery']);
  assert.match(items[0].querySelector('.snapshot-item-meta').textContent, /^2 min ago · 1\.2k chars$/);
  assert.match(items[1].querySelector('.snapshot-item-meta').textContent, /^2 hr ago · 50 chars$/);

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  await controller.openFor(button);
  await controller.openFor(button);
  assert.equal(menu.classList.contains('hidden'), true, 'a second click on the same trigger toggles the menu closed');
});

test('an empty list and a failed list render explanatory rows instead of actions', async () => {
  reset();
  fake.snapshots = [];
  await controller.openFor(trigger());
  assert.match(byId('snapshot-list').querySelector('.snapshot-empty').textContent, /No response snapshot is available/);
  controller.closeMenu();
  fake.snapshots = null;
  await controller.openFor(trigger());
  assert.equal(byId('snapshot-list').querySelectorAll('.snapshot-item').length, 0);
  controller.closeMenu();
});

test('Restore previews a diff, then restores through the worker and records the chat context event', async () => {
  reset();
  await controller.openFor(trigger());
  byId('snapshot-list').querySelector('.snapshot-restore-action').click();
  await settle();
  const layer = byId('snapshot-dialog-layer');
  assert.equal(layer.classList.contains('hidden'), false);
  assert.equal(layer.dataset.dialogMode, 'restore');
  assert.equal(byId('snapshot-dialog-title').textContent, 'Restore this snapshot?');
  assert.ok(byId('snapshot-dialog-body').querySelector('.edit-diff'), 'the current-to-saved diff is shown');
  assert.match(byId('snapshot-dialog-body').textContent, /Before restore/);
  assert.equal(byId('snapshot-menu').classList.contains('hidden'), true, 'the menu closes when the dialog opens');
  const previewRequest = fake.requests.find(message => message.type === PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW);
  assert.deepEqual(previewRequest, { type: PROTOCOL.DOCUMENT_SNAPSHOT_PREVIEW, tabId: 7, projectId: 'project', sessionId: 'session', snapshotId: 'snap-1' });

  byId('snapshot-dialog-confirm').click();
  await settle(5);
  const restoreRequest = fake.requests.find(message => message.type === PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE);
  assert.deepEqual(restoreRequest, { type: PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE, tabId: 7, projectId: 'project', sessionId: 'session', snapshotId: 'snap-1' });
  assert.equal(fake.restored.length, 1);
  assert.equal(fake.restored[0][0].snapshotId, 'snap-1');
  assert.deepEqual(fake.restored[0][1], { tabId: 7, projectId: 'project', sessionId: 'session' });
  assert.equal(layer.classList.contains('hidden'), true);
  assert.deepEqual(fake.statuses.at(-1), ['Snapshot restored; the previous document was saved', false]);
});

test('a snapshot identical to the live document disables Restore', async () => {
  reset();
  fake.previewResult = () => ({ ok: true, snapshot: automatic, noChanges: true, preview: null });
  await controller.openFor(trigger());
  byId('snapshot-list').querySelector('.snapshot-restore-action').click();
  await settle();
  assert.equal(byId('snapshot-dialog-title').textContent, 'Already at this snapshot');
  const confirm = byId('snapshot-dialog-confirm');
  assert.equal(confirm.disabled, true);
  assert.equal(confirm.textContent, 'Already current');
  byId('snapshot-dialog-cancel').click();
  assert.equal(byId('snapshot-dialog-layer').classList.contains('hidden'), true);
});

test('a project or chat change between preview and confirm aborts the restore', async () => {
  reset();
  await controller.openFor(trigger());
  byId('snapshot-list').querySelector('.snapshot-restore-action').click();
  await settle();
  fake.scope = { tabId: 7, projectId: 'project', sessionId: 'another-session' };
  byId('snapshot-dialog-confirm').click();
  await settle();
  assert.equal(fake.requests.some(message => message.type === PROTOCOL.DOCUMENT_SNAPSHOT_RESTORE), false);
  assert.equal(byId('snapshot-dialog-layer').classList.contains('hidden'), true);
  assert.match(fake.statuses.at(-1)[0], /project or chat changed/);
});

test('a failed preview reports the error and leaves the menu open', async () => {
  reset();
  fake.previewResult = () => { throw new Error('tab closed'); };
  await controller.openFor(trigger());
  byId('snapshot-list').querySelector('.snapshot-restore-action').click();
  await settle();
  assert.deepEqual(fake.statuses.at(-1), ['Snapshot preview failed: tab closed', true]);
  assert.equal(byId('snapshot-menu').classList.contains('hidden'), false);
  assert.equal(byId('snapshot-dialog-layer').classList.contains('hidden'), true);
  controller.closeMenu();
});

test('Delete confirms in the panel, deletes through the worker, and reopens the refreshed list', async () => {
  reset();
  const button = trigger();
  await controller.openFor(button);
  byId('snapshot-list').querySelector('.snapshot-delete-action').click();
  await settle();
  const layer = byId('snapshot-dialog-layer');
  assert.equal(layer.dataset.dialogMode, 'delete');
  assert.equal(byId('snapshot-dialog-title').textContent, 'Delete this snapshot?');
  assert.match(byId('snapshot-dialog-subtitle').textContent, /After latest response · main\.typ/);
  const confirm = byId('snapshot-dialog-confirm');
  assert.equal(confirm.textContent, 'Delete');
  assert.ok(confirm.classList.contains('btn-danger'));
  confirm.click();
  await settle(6);
  const deleteRequest = fake.requests.find(message => message.type === PROTOCOL.DOCUMENT_SNAPSHOT_DELETE);
  assert.deepEqual(deleteRequest, { type: PROTOCOL.DOCUMENT_SNAPSHOT_DELETE, tabId: 7, projectId: 'project', sessionId: 'session', snapshotId: 'snap-1' });
  assert.ok(fake.statuses.some(([text]) => text === 'Snapshot deleted'));
  assert.equal(layer.classList.contains('hidden'), true);
  assert.equal(byId('snapshot-menu').classList.contains('hidden'), false, 'the menu reopens on the same trigger');
  assert.deepEqual([...byId('snapshot-list').querySelectorAll('.snapshot-item strong')].map(el => el.textContent), ['Before restore']);
  controller.closeMenu();
});

test('locking closes the menu, disables actions, and blocks opening', async () => {
  reset();
  const button = trigger();
  await controller.openFor(button);
  fake.locked = true;
  controller.setLocked();
  assert.equal(byId('snapshot-menu').classList.contains('hidden'), true);
  assert.equal(button.disabled, true);
  await controller.openFor(button);
  assert.equal(byId('snapshot-menu').classList.contains('hidden'), true);
  fake.locked = false;
  controller.setLocked();
  assert.equal(button.disabled, false);
});

test('snapshot dates are described relative to now', () => {
  const base = 1_700_000_000_000;
  assert.equal(formatSnapshotDate(base - 10_000, base), 'Just now');
  assert.equal(formatSnapshotDate(base - 5 * 60_000, base), '5 min ago');
  assert.equal(formatSnapshotDate(base - 3 * 60 * 60_000, base), '3 hr ago');
  assert.equal(formatSnapshotDate('nope', base), 'Saved recently');
  assert.ok(formatSnapshotDate(base - 3 * 24 * 60 * 60_000, base).length > 0);
});
