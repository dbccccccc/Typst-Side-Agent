import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertEditCheckpoint } from '../src/background/edit-revert.js';
import { applyTextChanges, sha256Text } from '../src/shared/edit-checkpoint.js';
import { PROTOCOL } from '../src/shared/protocol.js';

async function checkpointRecord(beforeText, afterText, overrides = {}) {
  return {
    id: 'edit-fixture',
    projectId: 'project-a',
    sessionId: 'session-a',
    runId: 'run-a',
    callId: 'call-a',
    fileLabel: 'main.typ',
    status: 'applied',
    previousStatus: '',
    beforeText,
    beforeHash: await sha256Text(beforeText),
    beforeLength: beforeText.length,
    afterHash: await sha256Text(afterText),
    afterLength: afterText.length,
    pendingAfterHash: null,
    pendingAfterLength: null,
    previousAfterHash: null,
    previousAfterLength: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  };
}

function revertFixture(initialRecord, initialText, fixtureOptions = {}) {
  const records = (Array.isArray(initialRecord) ? initialRecord : [initialRecord]).map(record => structuredClone(record));
  let text = initialText;
  let generatedIds = 0;
  const calls = [];
  const counts = { commits: 0, rollbacks: 0, begins: 0, restores: 0, marks: 0, tabsGet: 0 };
  const findRecord = id => records.find(record => record.id === id) || null;
  const summary = record => record && ({ id: record.id, status: record.status, fileLabel: record.fileLabel, createdAt: record.createdAt });
  const adapters = {
    tabsGet: async tabId => {
      counts.tabsGet += 1;
      return { id: tabId, url: 'https://typst.app/project/project-a' };
    },
    sendPageRequest: async (_tabId, type, payload, options = {}) => {
      calls.push({ type, payload: structuredClone(payload), options: structuredClone(options) });
      if (type === PROTOCOL.PAGE_GET_CONTEXT) {
        return {
          fullText: text,
          editorToken: 'editor-fixture',
          workspace: { focused_element_file_hint: 'main.typ' }
        };
      }
      if (type === PROTOCOL.PAGE_APPLY_EDIT) {
        const checkpointId = String(payload.callId || '').replace(/^revert-/, '');
        if (fixtureOptions.failApplyIds?.includes(checkpointId)) {
          return { result: { ok: false, code: 'FIXTURE_REJECTED', error: `Rejected ${checkpointId}` } };
        }
        assert.equal(payload.expectedText, text);
        assert.equal(payload.expectedEditorToken, 'editor-fixture');
        assert.equal(payload.expectedFileLabel, 'main.typ');
        text = applyTextChanges(text, payload.changes);
        return { result: { ok: true, edits_applied: 1 } };
      }
      throw new Error(`Unexpected page request ${type}`);
    },
    loadEditCheckpoint: async id => {
      const record = findRecord(id);
      return record ? structuredClone(record) : null;
    },
    loadEditCheckpointCascade: async id => {
      const position = records.findIndex(record => record.id === id);
      if (position < 0) return null;
      const selected = records[position];
      return records.slice(position).filter(record =>
        record.projectId === selected.projectId && record.sessionId === selected.sessionId
      ).map(record => structuredClone(record));
    },
    commitEditCheckpoint: async id => {
      const record = findRecord(id);
      assert.ok(record);
      counts.commits += 1;
      Object.assign(record, {
        status: 'applied',
        previousStatus: '',
        afterHash: record.pendingAfterHash,
        afterLength: record.pendingAfterLength,
        pendingAfterHash: null,
        pendingAfterLength: null,
        previousAfterHash: null,
        previousAfterLength: null
      });
      return summary(record);
    },
    rollbackEditCheckpointPreparation: async id => {
      const position = records.findIndex(record => record.id === id);
      assert.ok(position >= 0);
      const record = records[position];
      counts.rollbacks += 1;
      if (record.previousStatus === 'applied') {
        Object.assign(record, {
          status: 'applied',
          previousStatus: '',
          afterHash: record.previousAfterHash,
          afterLength: record.previousAfterLength,
          pendingAfterHash: null,
          pendingAfterLength: null,
          previousAfterHash: null,
          previousAfterLength: null
        });
      } else {
        records.splice(position, 1);
      }
      return { ok: true };
    },
    beginEditCheckpointRevert: async id => {
      const record = findRecord(id);
      assert.ok(record);
      counts.begins += 1;
      record.status = 'reverting';
      return structuredClone(record);
    },
    restoreEditCheckpointApplied: async id => {
      const record = findRecord(id);
      assert.ok(record);
      counts.restores += 1;
      record.status = 'applied';
      return structuredClone(record);
    },
    markEditCheckpointReverted: async id => {
      const record = findRecord(id);
      assert.ok(record);
      counts.marks += 1;
      record.status = 'reverted';
      record.beforeText = null;
      return summary(record);
    },
    sha256Text,
    createId: () => `fixture-id-${++generatedIds}`
  };
  return {
    adapters,
    calls,
    counts,
    text: () => text,
    record: id => structuredClone(id ? findRecord(id) : records[0]),
    records: () => structuredClone(records)
  };
}

const payload = Object.freeze({
  checkpointId: 'edit-fixture',
  tabId: 7,
  projectId: 'project-a',
  sessionId: 'session-a'
});

test('revert replaces the exact final document in one guarded page transaction', async () => {
  const record = await checkpointRecord('= Before', '= After');
  const fixture = revertFixture(record, '= After');
  const result = await revertEditCheckpoint(payload, { adapters: fixture.adapters, activeRuns: [] });

  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.status, 'reverted');
  assert.equal(fixture.text(), '= Before');
  assert.equal(fixture.counts.begins, 1);
  assert.equal(fixture.counts.marks, 1);
  assert.deepEqual(fixture.calls.map(call => call.type), [PROTOCOL.PAGE_GET_CONTEXT, PROTOCOL.PAGE_APPLY_EDIT]);
  const apply = fixture.calls[1];
  assert.deepEqual(apply.payload.changes, [{ from: 0, to: '= After'.length, insert: '= Before' }]);
  assert.equal(apply.options.runId, 'revert-fixture-id-1');
});

test('reverting an older response cascades newest-to-selected', async () => {
  const records = await Promise.all([
    checkpointRecord('= Base', '= First', { id: 'edit-first', runId: 'run-first', callId: 'call-first', createdAt: 100 }),
    checkpointRecord('= First', '= Second', { id: 'edit-second', runId: 'run-second', callId: 'call-second', createdAt: 200 }),
    checkpointRecord('= Second', '= Third', { id: 'edit-third', runId: 'run-third', callId: 'call-third', createdAt: 300 })
  ]);
  const fixture = revertFixture(records, '= Third');
  const result = await revertEditCheckpoint({ ...payload, checkpointId: 'edit-first' }, {
    adapters: fixture.adapters,
    activeRuns: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.revertedCount, 3);
  assert.equal(result.checkpoint.id, 'edit-first');
  assert.deepEqual(result.checkpoints.map(checkpoint => checkpoint.id), ['edit-third', 'edit-second', 'edit-first']);
  assert.equal(fixture.text(), '= Base');
  assert.equal(fixture.counts.begins, 3);
  assert.equal(fixture.counts.marks, 3);
  assert.deepEqual(fixture.calls.map(call => call.type), [
    PROTOCOL.PAGE_GET_CONTEXT, PROTOCOL.PAGE_APPLY_EDIT,
    PROTOCOL.PAGE_GET_CONTEXT, PROTOCOL.PAGE_APPLY_EDIT,
    PROTOCOL.PAGE_GET_CONTEXT, PROTOCOL.PAGE_APPLY_EDIT
  ]);
  assert.deepEqual(
    fixture.calls.filter(call => call.type === PROTOCOL.PAGE_APPLY_EDIT).map(call => call.payload.changes[0].insert),
    ['= Second', '= First', '= Base']
  );
  assert.ok(fixture.records().every(record => record.status === 'reverted'));
});

test('cascade stops at the first unsuccessful step and reports completed newer reverts', async () => {
  const records = await Promise.all([
    checkpointRecord('= Base', '= First', { id: 'edit-first', createdAt: 100 }),
    checkpointRecord('= First', '= Second', { id: 'edit-second', createdAt: 200 }),
    checkpointRecord('= Second', '= Third', { id: 'edit-third', createdAt: 300 })
  ]);
  const fixture = revertFixture(records, '= Third', { failApplyIds: ['edit-second'] });

  await assert.rejects(
    revertEditCheckpoint({ ...payload, checkpointId: 'edit-first' }, { adapters: fixture.adapters, activeRuns: [] }),
    error => {
      assert.equal(error.code, 'FIXTURE_REJECTED');
      assert.match(error.message, /1 newer response was reverted/i);
      assert.equal(error.details.failedCheckpointId, 'edit-second');
      assert.deepEqual(error.details.checkpoints.map(checkpoint => checkpoint.id), ['edit-third']);
      return true;
    }
  );
  assert.equal(fixture.text(), '= Second');
  assert.deepEqual(fixture.records().map(record => [record.id, record.status]), [
    ['edit-first', 'applied'],
    ['edit-second', 'applied'],
    ['edit-third', 'reverted']
  ]);
  assert.equal(fixture.counts.restores, 1);
  assert.deepEqual(fixture.calls.map(call => call.type), [
    PROTOCOL.PAGE_GET_CONTEXT, PROTOCOL.PAGE_APPLY_EDIT,
    PROTOCOL.PAGE_GET_CONTEXT, PROTOCOL.PAGE_APPLY_EDIT
  ]);
});

test('revert refuses to overwrite a document changed after the response', async () => {
  const record = await checkpointRecord('= Before', '= After');
  const fixture = revertFixture(record, '= Newer user work');
  await assert.rejects(
    revertEditCheckpoint(payload, { adapters: fixture.adapters, activeRuns: [] }),
    error => error.code === 'EDIT_REVERT_CONFLICT'
  );
  assert.equal(fixture.text(), '= Newer user work');
  assert.equal(fixture.counts.begins, 0);
  assert.deepEqual(fixture.calls.map(call => call.type), [PROTOCOL.PAGE_GET_CONTEXT]);
});

test('revert reconciles a staged checkpoint when the page commit won the race', async () => {
  const beforeText = '= Before';
  const afterText = '= After';
  const record = await checkpointRecord(beforeText, afterText, {
    status: 'prepared',
    afterHash: null,
    afterLength: null,
    pendingAfterHash: await sha256Text(afterText),
    pendingAfterLength: afterText.length,
    previousAfterHash: await sha256Text(beforeText),
    previousAfterLength: beforeText.length
  });
  const fixture = revertFixture(record, afterText);
  const result = await revertEditCheckpoint(payload, { adapters: fixture.adapters, activeRuns: [] });
  assert.equal(result.ok, true);
  assert.equal(fixture.counts.commits, 1);
  assert.equal(fixture.text(), beforeText);
});

test('revert recovers an interrupted restore that already reached the original text', async () => {
  const beforeText = '= Before';
  const record = await checkpointRecord(beforeText, '= After', { status: 'reverting' });
  const fixture = revertFixture(record, beforeText);
  const result = await revertEditCheckpoint(payload, { adapters: fixture.adapters, activeRuns: [] });
  assert.equal(result.alreadyReverted, true);
  assert.equal(result.checkpoint.status, 'reverted');
  assert.equal(fixture.counts.marks, 1);
  assert.deepEqual(fixture.calls.map(call => call.type), [PROTOCOL.PAGE_GET_CONTEXT]);
});

test('revert is blocked before page access while an agent run owns the tab', async () => {
  const record = await checkpointRecord('= Before', '= After');
  const fixture = revertFixture(record, '= After');
  await assert.rejects(
    revertEditCheckpoint(payload, { adapters: fixture.adapters, activeRuns: [{ tabId: 7 }] }),
    error => error.code === 'EDIT_REVERT_RUN_ACTIVE'
  );
  assert.equal(fixture.counts.tabsGet, 0);
  assert.deepEqual(fixture.calls, []);
});
