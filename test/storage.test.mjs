import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureStorageAdapter, resetStorageAdapter, restrictStorageAccess,
  loadCustomTools, loadMcpServers, loadSettings, saveCustomTools, saveMcpServers, saveSettings,
  sessionCreate, sessionDelete, sessionDeleteByProject, sessionExport, sessionGet,
  sessionImport, sessionList, sessionListAllGrouped, sessionStorageStatus, sessionUpdate,
  beginEditCheckpointRevert, commitEditCheckpoint, loadEditCheckpoint, loadEditCheckpointCascade,
  markEditCheckpointReverted,
  prepareEditCheckpointUpdate, restoreEditCheckpointApplied, rollbackEditCheckpointPreparation,
  stageEditCheckpoint, createDocumentSnapshot, deleteAutomaticDocumentSnapshots,
  deleteDocumentSnapshot, invalidateAutomaticDocumentSnapshots, listDocumentSnapshots,
  loadDocumentSnapshot
} from '../src/background/storage.js';
import { LIMITS, STORAGE_KEYS } from '../src/shared/constants.js';
import { sha256Text } from '../src/shared/edit-checkpoint.js';
import { DOCUMENT_SNAPSHOT_KINDS } from '../src/shared/document-snapshot.js';
import { deferred, FakeStorage } from './helpers/fakes.mjs';
import { customToolTrustFingerprint, mcpServerTrustFingerprint } from '../src/shared/trust-policy.js';

afterEach(() => resetStorageAdapter());

test('editor approval mode defaults to ask, persists auto, and fails closed', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);

  assert.equal((await loadSettings()).editorApprovalMode, 'ask');
  await saveSettings({ editorApprovalMode: 'auto' });
  assert.equal((await loadSettings()).editorApprovalMode, 'auto');

  storage.data[STORAGE_KEYS.SETTINGS].editorApprovalMode = 'unexpected';
  assert.equal((await loadSettings()).editorApprovalMode, 'ask');
  await saveSettings({ editorApprovalMode: 'unexpected' });
  assert.equal(storage.data[STORAGE_KEYS.SETTINGS].editorApprovalMode, 'ask');
});

test('send message shortcut defaults to Enter, persists alternatives, and normalizes unknown values', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);

  assert.equal((await loadSettings()).sendMessageShortcut, 'enter');
  await saveSettings({ sendMessageShortcut: 'shift-enter' });
  assert.equal((await loadSettings()).sendMessageShortcut, 'shift-enter');

  await saveSettings({ sendMessageShortcut: 'ctrl-enter' }, { fields: ['sendMessageShortcut'] });
  assert.equal((await loadSettings()).sendMessageShortcut, 'ctrl-enter');

  storage.data[STORAGE_KEYS.SETTINGS].sendMessageShortcut = 'unexpected';
  assert.equal((await loadSettings()).sendMessageShortcut, 'enter');
  await saveSettings({ sendMessageShortcut: 'unexpected' }, { fields: ['sendMessageShortcut'] });
  assert.equal(storage.data[STORAGE_KEYS.SETTINGS].sendMessageShortcut, 'enter');
});

test('worker-owned settings and registry mutations preserve overlapping writers', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const modelA = { id: 'model-a', name: 'A', apiBaseUrl: 'https://model-a.example/v1', apiKey: 'a', modelId: 'a' };
  const modelB = { id: 'model-b', name: 'B', apiBaseUrl: 'https://model-b.example/v1', apiKey: 'b', modelId: 'b' };
  await saveSettings({ models: [modelA], activeModelId: modelA.id });
  const staleSettings = await loadSettings();
  await Promise.all([
    saveSettings({ ...staleSettings, systemPrompt: 'updated' }, { fields: ['systemPrompt'] }),
    saveSettings(staleSettings, { modelMutation: { type: 'upsert', record: modelB } })
  ]);
  const settings = await loadSettings();
  assert.equal(settings.systemPrompt, 'updated');
  assert.deepEqual(settings.models.map(model => model.id).sort(), ['model-a', 'model-b']);

  const toolA = { id: 'tool-a', name: 'tool_a', endpoint: 'https://tools.example/a', enabled: true, parameters: { type: 'object', properties: {} } };
  const toolB = { id: 'tool-b', name: 'tool_b', endpoint: 'https://tools.example/b', enabled: true, parameters: { type: 'object', properties: {} } };
  await saveCustomTools([toolA]);
  const staleTools = await loadCustomTools();
  await Promise.all([
    saveCustomTools(staleTools, { type: 'toggle', id: toolA.id }),
    saveCustomTools(staleTools, { type: 'upsert', record: toolB })
  ]);
  const tools = await loadCustomTools();
  assert.equal(tools.find(tool => tool.id === toolA.id).enabled, false);
  assert.deepEqual(tools.map(tool => tool.id).sort(), ['tool-a', 'tool-b']);
});

test('v2 repository serializes concurrent create/update/delete mutations', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const [a, b, c] = await Promise.all([
    sessionCreate('project-a', 'A'),
    sessionCreate('project-a', 'B'),
    sessionCreate('project-b', 'C')
  ]);
  assert.equal((await sessionList('project-a')).length, 2);
  await Promise.all([
    sessionUpdate(a.id, { messages: [{ role: 'user', content: 'one' }] }),
    sessionUpdate(b.id, { messages: [{ role: 'user', content: 'two' }] })
  ]);
  assert.equal((await sessionGet(a.id)).messages[0].content, 'one');
  assert.equal((await sessionGet(b.id)).messages[0].content, 'two');
  assert.equal((await sessionDeleteByProject('project-a')).removed, 2);
  assert.equal((await sessionList('project-a')).length, 0);
  assert.equal((await sessionGet(c.id)).name, 'C');
  assert.equal((await sessionDelete(c.id)).removed, 1);
});

test('automatic naming refreshes generated titles but never overwrites a manual rename', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const session = await sessionCreate('project', 'New chat');

  assert.equal((await sessionUpdate(session.id, { name: 'First generated', autoName: true })).name, 'First generated');
  assert.equal((await sessionUpdate(session.id, { name: 'Second generated', autoName: true })).name, 'Second generated');
  await sessionUpdate(session.id, { name: 'My title', userRenamed: true });

  const guarded = await sessionUpdate(session.id, { name: 'Late generated title', autoName: true });
  assert.equal(guarded.name, 'My title');
  assert.equal(guarded.userRenamed, true);
  assert.equal((await sessionGet(session.id)).name, 'My title');
});

test('session body reads hold one committed repository snapshot while an update waits', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const session = await sessionCreate('project', 'Snapshot');
  await sessionUpdate(session.id, { messages: [{ role: 'user', content: 'old' }] });
  const bodyKey = storage.data[STORAGE_KEYS.SESSION_INDEX].sessions[0].bodyKey;
  const bodyReadStarted = deferred();
  const releaseBodyRead = deferred();
  let held = false;
  storage.hooks.beforeGet = async keys => {
    if (!held && (Array.isArray(keys) ? keys : [keys]).includes(bodyKey)) {
      held = true;
      bodyReadStarted.resolve();
      await releaseBodyRead.promise;
    }
  };

  const read = sessionGet(session.id);
  await bodyReadStarted.promise;
  const update = sessionUpdate(session.id, { messages: [{ role: 'user', content: 'new' }] });
  releaseBodyRead.resolve();
  assert.equal((await read).messages[0].content, 'old');
  assert.equal((await update).messages[0].content, 'new');
  assert.equal((await sessionGet(session.id)).messages[0].content, 'new');
});

test('project listing returns metadata and reads a body only when selected', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  await sessionCreate('project-a', 'A');
  await sessionCreate('project-b', 'B');
  const metadata = storage.data[STORAGE_KEYS.SESSION_INDEX].sessions;
  const bodyA = metadata.find(item => item.projectId === 'project-a').bodyKey;
  const bodyB = metadata.find(item => item.projectId === 'project-b').bodyKey;
  const reads = [];
  storage.hooks.beforeGet = keys => { reads.push(...(Array.isArray(keys) ? keys : [keys])); };
  const listed = await sessionList('project-a');
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], 'messages'), false);
  assert.equal(Object.hasOwn(listed[0], 'bodyKey'), false);
  assert.equal(Object.hasOwn(listed[0], 'searchText'), false);
  assert.equal(reads.includes(bodyA), false);
  assert.equal(reads.includes(bodyB), false);
  await sessionGet(listed[0].id);
  assert.equal(reads.includes(bodyA), true);
});

test('invalid session indexes fail closed without deleting intact bodies', async () => {
  const bodyKey = `${STORAGE_KEYS.SESSION_BODY_PREFIX}preserved.version`;
  const storage = new FakeStorage({
    [STORAGE_KEYS.SESSION_INDEX]: { version: 999, sessions: [] },
    [STORAGE_KEYS.SESSION_MIGRATION]: { version: 2, complete: true },
    [bodyKey]: { version: 2, id: 'preserved', messages: [{ role: 'user', content: 'keep me' }] }
  });
  configureStorageAdapter(storage);
  await assert.rejects(sessionList('p'), error => error.code === 'SESSION_INDEX_INVALID');
  assert.equal(storage.data[bodyKey].messages[0].content, 'keep me');
});

test('missing session indexes fail closed before later writes can orphan existing bodies', async () => {
  const bodyKey = `${STORAGE_KEYS.SESSION_BODY_PREFIX}preserved.version`;
  const storage = new FakeStorage({
    [STORAGE_KEYS.SESSION_MIGRATION]: { version: 2, complete: true },
    [bodyKey]: { version: 2, id: 'preserved', messages: [] }
  });
  configureStorageAdapter(storage);
  await assert.rejects(sessionList('p'), error => error.code === 'SESSION_INDEX_MISSING');
  await assert.rejects(sessionCreate('p'), error => error.code === 'SESSION_INDEX_MISSING');
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.SESSION_INDEX), false);
  assert.equal(Object.hasOwn(storage.data, bodyKey), true);
});

test('missing indexes resume legacy migration only when every body matches legacy data', async () => {
  const legacy = [{ id: 'legacy', projectId: 'p', name: 'Legacy', messages: [] }];
  const unrelatedBodyKey = `${STORAGE_KEYS.SESSION_BODY_PREFIX}newer.version`;
  const storage = new FakeStorage({
    [STORAGE_KEYS.SESSIONS]: legacy,
    [unrelatedBodyKey]: { version: 2, id: 'newer', messages: [{ role: 'user', content: 'preserve newer data' }] }
  });
  configureStorageAdapter(storage);
  await assert.rejects(sessionList('p'), error => error.code === 'SESSION_INDEX_MISSING');
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.SESSION_INDEX), false);
  assert.equal(storage.data[unrelatedBodyKey].messages[0].content, 'preserve newer data');
  assert.deepEqual(storage.data[STORAGE_KEYS.SESSIONS], legacy);
});

test('existing v2 metadata receives a one-time bounded search summary', async () => {
  const bodyKey = `${STORAGE_KEYS.SESSION_BODY_PREFIX}old.version`;
  const storage = new FakeStorage({
    [STORAGE_KEYS.SESSION_MIGRATION]: { version: 2, complete: true },
    [STORAGE_KEYS.SESSION_INDEX]: { version: 2, sessions: [{
      id: 'old', projectId: 'p', name: 'Old', createdAt: 1, updatedAt: 2,
      messageCount: 1, approxBytes: 100, bodyKey, userRenamed: false
    }] },
    [bodyKey]: { version: 2, id: 'old', messages: [{ role: 'user', content: 'Searchable old message' }] }
  });
  configureStorageAdapter(storage);
  const listed = await sessionList('p');
  assert.equal(listed[0].preview, 'Searchable old message');
  assert.equal(Object.hasOwn(listed[0], 'searchText'), false);
  assert.equal(storage.data[STORAGE_KEYS.SESSION_INDEX].sessions[0].searchText, 'searchable old message');
});

test('legacy consent fails closed and current trust fingerprints survive only exact configurations', async () => {
  const storage = new FakeStorage({
    [STORAGE_KEYS.CUSTOM_TOOLS]: [{
      id: 'legacy-tool', name: 'legacy_tool', endpoint: 'http://192.168.1.5/call',
      parameters: { type: 'object', properties: {} }, trustedAutoRun: true,
      insecureTransportAcknowledged: true
    }],
    [STORAGE_KEYS.MCP_SERVERS]: [{
      id: 'legacy-server', name: 'legacy', url: 'http://192.168.1.6/rpc',
      trustedAutoRun: true, insecureTransportAcknowledged: true
    }]
  });
  configureStorageAdapter(storage);
  assert.deepEqual((await loadCustomTools()).map(item => [item.trustedAutoRun, item.insecureTransportAcknowledged]), [[false, false]]);
  assert.deepEqual((await loadMcpServers()).map(item => [item.trustedAutoRun, item.insecureTransportAcknowledged]), [[false, false]]);

  const custom = {
    id: 'tool-1', name: 'lookup', endpoint: 'http://192.168.1.5/call', headers: {},
    parameters: { type: 'object', properties: {} }, trustedAutoRun: true,
    insecureTransportAcknowledged: true,
    insecureTransportAcknowledgedOrigin: 'http://192.168.1.5'
  };
  custom.trustedAutoRunFingerprint = customToolTrustFingerprint(custom);
  const server = {
    id: 'server-1', name: 'mcp', url: 'https://mcp.example/rpc', headers: {}, protocolMode: 'auto',
    trustedAutoRun: true
  };
  server.trustedAutoRunFingerprint = mcpServerTrustFingerprint(server);
  await saveCustomTools([custom]);
  await saveMcpServers([server]);
  assert.equal((await loadCustomTools())[0].trustedAutoRun, true);
  assert.equal((await loadMcpServers())[0].trustedAutoRun, true);

  storage.data[STORAGE_KEYS.CUSTOM_TOOLS][0].endpoint = 'http://192.168.1.7/call';
  storage.data[STORAGE_KEYS.MCP_SERVERS][0].headers = { Authorization: 'changed' };
  assert.deepEqual((await loadCustomTools()).map(item => [item.trustedAutoRun, item.insecureTransportAcknowledged]), [[false, false]]);
  assert.equal((await loadMcpServers())[0].trustedAutoRun, false);
});

test('body is written before metadata and failed oversized update preserves old session', async () => {
  const writes = [];
  const storage = new FakeStorage({}, { beforeSet: values => { writes.push(Object.keys(values)[0]); } });
  configureStorageAdapter(storage);
  const session = await sessionCreate('project', 'Chat');
  const bodyKey = writes.find(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX));
  assert.ok(writes.indexOf(bodyKey) < writes.lastIndexOf(STORAGE_KEYS.SESSION_INDEX));
  await sessionUpdate(session.id, { messages: [{ role: 'user', content: 'safe' }] });
  const huge = 'x'.repeat(LIMITS.MAX_SESSION_BODY_BYTES + 1);
  await assert.rejects(sessionUpdate(session.id, { messages: [{ role: 'user', content: huge }] }), error => error.code === 'INVALID_SESSION_RECORD' || error.code === 'SESSION_TOO_LARGE');
  assert.equal((await sessionGet(session.id)).messages[0].content, 'safe');
});

test('failed index publication cannot expose an uncommitted replacement body', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const session = await sessionCreate('project', 'Chat');
  await sessionUpdate(session.id, { messages: [{ role: 'user', content: 'committed' }] });
  const beforeMeta = storage.data[STORAGE_KEYS.SESSION_INDEX].sessions[0];
  let failed = false;
  storage.hooks.beforeSet = values => {
    if (!failed && Object.hasOwn(values, STORAGE_KEYS.SESSION_INDEX)) {
      failed = true;
      throw new Error('simulated interrupted index write');
    }
  };
  await assert.rejects(sessionUpdate(session.id, { messages: [{ role: 'user', content: 'uncommitted' }] }), /interrupted index write/);
  const afterMeta = storage.data[STORAGE_KEYS.SESSION_INDEX].sessions[0];
  assert.equal(afterMeta.bodyKey, beforeMeta.bodyKey);
  assert.equal((await sessionGet(session.id)).messages[0].content, 'committed');
  const bodyKeys = Object.keys(storage.data).filter(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX));
  assert.deepEqual(bodyKeys, [beforeMeta.bodyKey]);
});

test('legacy aggregate migrates once with display-only attachment compatibility', async () => {
  const legacy = [{
    id: 'legacy-1', projectId: 'p', name: 'Old', createdAt: 1, updatedAt: 2,
    messages: [{ role: 'user', content: 'hello', sentAttachments: { document: true, diagnosticsCount: 3 } }]
  }];
  const storage = new FakeStorage({ [STORAGE_KEYS.SESSIONS]: legacy });
  configureStorageAdapter(storage);
  const listed = await sessionList('p');
  assert.equal(listed.length, 1);
  const loaded = await sessionGet(listed[0].id);
  assert.equal(loaded.messages[0].sentAttachments.legacyDocument, true);
  assert.equal(loaded.messages[0].sentAttachments.legacyDiagnosticsCount, 3);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.SESSIONS), false);
  assert.equal(storage.data[STORAGE_KEYS.SESSION_MIGRATION].complete, true);
});

test('legacy migration preserves every record when explicit ids collide', async () => {
  const storage = new FakeStorage({
    [STORAGE_KEYS.SESSIONS]: [
      { id: 'duplicate', projectId: 'p', name: 'First', messages: [{ role: 'user', content: 'one' }] },
      { id: 'duplicate', projectId: 'p', name: 'Second', messages: [{ role: 'user', content: 'two' }] }
    ]
  });
  configureStorageAdapter(storage);
  const listed = await sessionList('p');
  assert.equal(listed.length, 2);
  assert.equal(new Set(listed.map(item => item.id)).size, 2);
  const loaded = await Promise.all(listed.map(item => sessionGet(item.id)));
  assert.deepEqual(loaded.map(item => item.messages[0].content).sort(), ['one', 'two']);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.SESSIONS), false);
});

test('legacy migration resumes after every write phase and cleans orphan bodies', async () => {
  const legacy = [
    { id: 'legacy-a', projectId: 'p', name: 'A', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'one' }] },
    { id: 'legacy-b', projectId: 'p', name: 'B', createdAt: 3, updatedAt: 4, messages: [{ role: 'user', content: 'two' }] }
  ];
  for (const failAt of [1, 2, 3, 4, 5, 6, 7]) {
    let writes = 0;
    let failed = false;
    const storage = new FakeStorage({ [STORAGE_KEYS.SESSIONS]: legacy }, {
      beforeSet: () => {
        writes += 1;
        if (!failed && writes === failAt) {
          failed = true;
          throw new Error(`interrupt-${failAt}`);
        }
      }
    });
    configureStorageAdapter(storage);
    await assert.rejects(sessionList('p'), new RegExp(`interrupt-${failAt}`));
    configureStorageAdapter(storage);
    const recovered = await sessionList('p');
    assert.deepEqual(recovered.map(item => item.id).sort(), ['legacy-a', 'legacy-b'], `phase ${failAt}`);
    assert.equal(storage.data[STORAGE_KEYS.SESSION_MIGRATION].complete, true, `phase ${failAt}`);
    assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.SESSIONS), false, `phase ${failAt}`);
    const referenced = new Set(storage.data[STORAGE_KEYS.SESSION_INDEX].sessions.map(item => item.bodyKey));
    const bodyKeys = Object.keys(storage.data).filter(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX));
    assert.deepEqual(new Set(bodyKeys), referenced, `phase ${failAt}`);
  }
});

test('completed migration retries legacy-key cleanup after interrupted removal', async () => {
  const storage = new FakeStorage({
    [STORAGE_KEYS.SESSIONS]: [{ id: 'legacy', projectId: 'p', name: 'A', messages: [] }]
  });
  const remove = storage.remove.bind(storage);
  let failed = false;
  storage.remove = async keys => {
    if (!failed && (Array.isArray(keys) ? keys : [keys]).includes(STORAGE_KEYS.SESSIONS)) {
      failed = true;
      throw new Error('remove interrupted');
    }
    return remove(keys);
  };
  configureStorageAdapter(storage);
  await assert.rejects(sessionList('p'), /remove interrupted/);
  assert.equal(storage.data[STORAGE_KEYS.SESSION_MIGRATION].complete, true);
  configureStorageAdapter(storage);
  assert.equal((await sessionList('p')).length, 1);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.SESSIONS), false);
});

test('v1/v2 import rejects malformed records and bounds retained previews/results', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const valid = {
    id: 'imported', projectId: 'p', name: 'Imported', messages: [
      { role: 'user', content: 'hello', activeEditorFile: {
        projectLabel: 'Project', relativePath: 'chapters/intro.typ', basename: 'intro.typ',
        source: 'header_breadcrumb', confidence: 'high'
      }, sentAttachments: { previews: [
        { dataUrl: 'https://remote.example/image.png' },
        { dataUrl: 'data:image/webp;base64,AAAA', width: 1, height: 1, mimeType: 'image/webp', thumbnail: true }
      ] } },
      { role: 'assistant', content: 'done', segments: [{ type: 'tools', calls: [{ id: 'c', name: 'external', args: {} }], results: { c: { ok: true, data: 'x'.repeat(10_000) } } }] }
    ]
  };
  const result = await sessionImport({ version: 2, sessions: [valid, { projectId: 'p', messages: 'bad' }] });
  assert.deepEqual(result, { ok: true, imported: 1, rejected: 1 });
  const importedMeta = (await sessionList('p'))[0];
  const imported = await sessionGet(importedMeta.id);
  assert.equal(imported.messages[0].activeEditorFile.relativePath, 'chapters/intro.typ');
  assert.equal(imported.messages[0].sentAttachments.previews[0].omitted, true);
  assert.equal(imported.messages[0].sentAttachments.previews[1].thumbnail, true);
  assert.ok(imported.messages[1].segments[0].results.c.summary.length <= LIMITS.MAX_PERSISTED_TOOL_RESULT_CHARS + 1);
  const exported = await sessionExport();
  assert.equal(exported.version, 2);
  assert.equal(exported.sessions.length, 1);
  assert.equal(exported.sessions[0].messages[0].activeEditorFile.relativePath, 'chapters/intro.typ');
});

test('session import enforces record limits before writing any body', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const records = Array.from({ length: LIMITS.MAX_SESSION_IMPORT_RECORDS + 1 }, (_, index) => ({
    id: `too-many-${index}`, projectId: 'p', messages: []
  }));
  await assert.rejects(sessionImport(records), error => error.code === 'SESSION_IMPORT_RECORD_LIMIT');
  const bodyKeys = Object.keys(storage.data).filter(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX));
  assert.deepEqual(bodyKeys, []);
});

test('session import publishes once and rolls back prepared bodies when index publication fails', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const existing = await sessionCreate('p', 'Existing');
  const originalIndex = structuredClone(storage.data[STORAGE_KEYS.SESSION_INDEX]);
  const originalBodyKey = originalIndex.sessions[0].bodyKey;
  let rejectedIndex = false;
  storage.hooks.beforeSet = values => {
    if (!rejectedIndex && Object.hasOwn(values, STORAGE_KEYS.SESSION_INDEX)) {
      rejectedIndex = true;
      throw new Error('index publication failed');
    }
  };
  await assert.rejects(sessionImport([{ id: 'imported', projectId: 'p', messages: [{ role: 'user', content: 'new' }] }]), /index publication failed/);
  assert.deepEqual(storage.data[STORAGE_KEYS.SESSION_INDEX], originalIndex);
  assert.deepEqual(
    Object.keys(storage.data).filter(key => key.startsWith(STORAGE_KEYS.SESSION_BODY_PREFIX)),
    [originalBodyKey]
  );
  assert.equal((await sessionGet(existing.id)).name, 'Existing');
});

test('session import rejects coercible objects and unsupported display segments', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const records = [
    { id: 'object-content', projectId: 'p', messages: [{ role: 'user', content: { toString: 'hostile' } }] },
    { id: 'unknown-segment', projectId: 'p', messages: [{ role: 'assistant', content: '', segments: [{ type: 'html', content: '<img src=x>' }] }] },
    { id: 'bad-tool-json', projectId: 'p', messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', function: { name: 'read_document', arguments: '{' } }] }] }
  ];
  assert.deepEqual(await sessionImport({ version: 2, sessions: records }), { ok: true, imported: 0, rejected: 3 });
  assert.equal((await sessionList('p')).length, 0);
});

test('grouping, storage status, and trusted-context restriction use the adapter', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const session = await sessionCreate('p', 'A');
  await sessionUpdate(session.id, { messages: [{ role: 'user', content: 'hello' }] });
  const groups = await sessionListAllGrouped();
  assert.equal(groups[0].totalMessages, 1);
  assert.equal(groups[0].sessions[0].searchText, 'hello');
  assert.equal(Object.hasOwn(groups[0].sessions[0], 'bodyKey'), false);
  assert.ok((await sessionStorageStatus()).bytes > 0);
  assert.deepEqual(await restrictStorageAccess(), { ok: true });
  assert.equal(storage.accessLevel, 'TRUSTED_CONTEXTS');
  storage.getBytesInUse = async () => LIMITS.STORAGE_WARNING_BYTES;
  assert.equal((await sessionStorageStatus()).warning, true);
});

test('quota failures use a stable visible error contract and do not poison later mutations', async () => {
  let reject = true;
  const storage = new FakeStorage({}, {
    beforeSet: () => {
      if (reject) throw new Error('QUOTA_BYTES quota exceeded');
    }
  });
  configureStorageAdapter(storage);
  await assert.rejects(sessionCreate('p', 'A'), error => error.code === 'STORAGE_QUOTA_EXCEEDED' && /unsaved/.test(error.message));
  reject = false;
  assert.equal((await sessionCreate('p', 'B')).name, 'B');
});

test('edit checkpoints stage before writes, advance, roll back, and discard bodies after revert', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const beforeText = '= Before';
  const firstText = '= First';
  const secondText = '= Second';
  const beforeHash = await sha256Text(beforeText);
  const firstHash = await sha256Text(firstText);
  const secondHash = await sha256Text(secondText);

  const staged = await stageEditCheckpoint({
    id: 'edit-lifecycle', projectId: 'p', sessionId: 's', runId: 'r', callId: 'c1',
    fileLabel: 'main.typ', beforeText, beforeHash,
    pendingAfterHash: firstHash, pendingAfterLength: firstText.length
  });
  assert.equal(staged.status, 'prepared');
  assert.equal((await loadEditCheckpoint(staged.id)).beforeText, beforeText);
  assert.equal((await commitEditCheckpoint(staged.id)).status, 'applied');

  await prepareEditCheckpointUpdate(staged.id, {
    callId: 'c2', pendingAfterHash: secondHash, pendingAfterLength: secondText.length
  });
  await rollbackEditCheckpointPreparation(staged.id);
  let checkpoint = await loadEditCheckpoint(staged.id);
  assert.equal(checkpoint.status, 'applied');
  assert.equal(checkpoint.afterHash, firstHash);

  await prepareEditCheckpointUpdate(staged.id, {
    callId: 'c2', pendingAfterHash: secondHash, pendingAfterLength: secondText.length
  });
  await commitEditCheckpoint(staged.id);
  await beginEditCheckpointRevert(staged.id);
  assert.equal((await loadEditCheckpoint(staged.id)).status, 'reverting');
  await restoreEditCheckpointApplied(staged.id);
  await beginEditCheckpointRevert(staged.id);
  assert.equal((await markEditCheckpointReverted(staged.id)).status, 'reverted');
  checkpoint = await loadEditCheckpoint(staged.id);
  assert.equal(checkpoint.beforeText, null);
  assert.equal(checkpoint.bodyKey, null);
  assert.equal(Object.keys(storage.data).some(key => key.startsWith(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX)), false);
});

test('checkpoint cascades preserve journal order and exclude later edits from other chats', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const stage = async ({ id, sessionId, beforeText, afterText }) => {
    await stageEditCheckpoint({
      id,
      projectId: 'project',
      sessionId,
      runId: `run-${id}`,
      callId: `call-${id}`,
      fileLabel: 'main.typ',
      beforeText,
      beforeHash: await sha256Text(beforeText),
      pendingAfterHash: await sha256Text(afterText),
      pendingAfterLength: afterText.length
    });
    await commitEditCheckpoint(id);
  };

  await stage({ id: 'edit-first', sessionId: 'chat-a', beforeText: '= Base', afterText: '= First' });
  await stage({ id: 'edit-other-chat', sessionId: 'chat-b', beforeText: '= Other', afterText: '= Other changed' });
  await stage({ id: 'edit-second', sessionId: 'chat-a', beforeText: '= First', afterText: '= Second' });

  const cascade = await loadEditCheckpointCascade('edit-first');
  assert.deepEqual(cascade.map(record => record.id), ['edit-first', 'edit-second']);
  assert.deepEqual(cascade.map(record => record.beforeText), ['= Base', '= First']);
  assert.deepEqual((await loadEditCheckpointCascade('edit-second')).map(record => record.id), ['edit-second']);
  assert.equal(await loadEditCheckpointCascade('missing'), null);
});

test('edit checkpoint retention is bounded and prunes the oldest body', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  for (let index = 0; index < LIMITS.MAX_EDIT_CHECKPOINTS + 1; index += 1) {
    const beforeText = `before-${index}`;
    const afterText = `after-${index}`;
    await stageEditCheckpoint({
      id: `edit-retain-${index}`, projectId: 'p', sessionId: `s-${index}`, runId: `r-${index}`, callId: 'c',
      beforeText,
      beforeHash: await sha256Text(beforeText),
      pendingAfterHash: await sha256Text(afterText),
      pendingAfterLength: afterText.length
    });
    await commitEditCheckpoint(`edit-retain-${index}`);
  }
  assert.equal((await loadEditCheckpoint('edit-retain-0')), null);
  assert.equal(storage.data[STORAGE_KEYS.EDIT_CHECKPOINT_INDEX].entries.length, LIMITS.MAX_EDIT_CHECKPOINTS);
  assert.equal(
    Object.keys(storage.data).filter(key => key.startsWith(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX)).length,
    LIMITS.MAX_EDIT_CHECKPOINTS
  );
});

test('checkpoint retention preserves in-flight transactions and cleans unpublished bodies', async () => {
  const orphanKey = `${STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX}orphan`;
  const storage = new FakeStorage({ [orphanKey]: { version: 1, id: 'orphan', beforeText: 'orphaned' } });
  configureStorageAdapter(storage);
  for (let index = 0; index < LIMITS.MAX_EDIT_CHECKPOINTS; index += 1) {
    const beforeText = `before-active-${index}`;
    const afterText = `after-active-${index}`;
    await stageEditCheckpoint({
      id: `edit-active-${index}`, projectId: 'p', sessionId: `s-${index}`, runId: `r-${index}`, callId: 'c',
      beforeText,
      beforeHash: await sha256Text(beforeText),
      pendingAfterHash: await sha256Text(afterText),
      pendingAfterLength: afterText.length
    });
  }
  assert.equal(Object.hasOwn(storage.data, orphanKey), false);
  const extraBefore = 'extra-before';
  await assert.rejects(stageEditCheckpoint({
    id: 'edit-active-extra', projectId: 'p', sessionId: 's-extra', runId: 'r-extra', callId: 'c',
    beforeText: extraBefore,
    beforeHash: await sha256Text(extraBefore),
    pendingAfterHash: await sha256Text('extra-after'),
    pendingAfterLength: 'extra-after'.length
  }), error => error.code === 'EDIT_CHECKPOINT_HISTORY_BUSY');
  assert.equal(storage.data[STORAGE_KEYS.EDIT_CHECKPOINT_INDEX].entries.length, LIMITS.MAX_EDIT_CHECKPOINTS);
  assert.equal(await loadEditCheckpoint('edit-active-0').then(record => record.status), 'prepared');
});

test('session exports omit checkpoint bodies and imported revert receipts are unavailable', async () => {
  const sourceStorage = new FakeStorage();
  configureStorageAdapter(sourceStorage);
  const beforeText = 'private original source';
  const afterText = 'public final source';
  await stageEditCheckpoint({
    id: 'edit-export', projectId: 'p', sessionId: 'session-export', runId: 'run-export', callId: 'call-export',
    fileLabel: 'main.typ', beforeText,
    beforeHash: await sha256Text(beforeText),
    pendingAfterHash: await sha256Text(afterText),
    pendingAfterLength: afterText.length
  });
  await commitEditCheckpoint('edit-export');
  const session = await sessionCreate('p', 'Exported');
  await sessionUpdate(session.id, { messages: [{
    role: 'assistant', content: 'Changed it.', segments: [{
      type: 'tools',
      calls: [{ id: 'call-export', name: 'search_replace', args: { search: 'a', replace: 'b' } }],
      results: { 'call-export': { ok: true, edits_applied: 1, editCheckpoint: {
        id: 'edit-export', status: 'applied', fileLabel: 'main.typ', createdAt: 100
      } } }
    }]
  }] });

  const exported = await sessionExport();
  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes(beforeText), false);
  assert.equal(serialized.includes(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX), false);

  const targetStorage = new FakeStorage();
  configureStorageAdapter(targetStorage);
  assert.deepEqual(await sessionImport(exported), { ok: true, imported: 1, rejected: 0 });
  const importedMeta = (await sessionList('p'))[0];
  const imported = await sessionGet(importedMeta.id);
  const receipt = imported.messages[0].segments[0].results['call-export'].editCheckpoint;
  assert.equal(receipt.status, 'unavailable');
  assert.match(receipt.unavailableReason, /not included/i);
  assert.equal(Object.keys(targetStorage.data).some(key => key.startsWith(STORAGE_KEYS.EDIT_CHECKPOINT_BODY_PREFIX)), false);
});

test('local snapshot restore events persist for context but are omitted from exports and imports', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const session = await sessionCreate('project', 'Restore context');
  const message = {
    role: 'assistant',
    content: 'Done.',
    responseStatus: 'complete',
    editorStateUpdates: [{
      kind: 'snapshot-restored',
      snapshotId: 'snapshot-one',
      fileLabel: 'main.typ',
      restoredAt: 100
    }]
  };
  await sessionUpdate(session.id, { messages: [message] });
  const localMessage = (await sessionGet(session.id)).messages[0];
  assert.equal(localMessage.editorStateUpdates[0].snapshotId, 'snapshot-one');
  assert.equal(localMessage.responseStatus, 'complete');
  const exported = await sessionExport();
  assert.equal(Object.hasOwn(exported.sessions[0].messages[0], 'editorStateUpdates'), false);
  assert.equal(exported.sessions[0].messages[0].responseStatus, 'complete');

  const importedStorage = new FakeStorage();
  configureStorageAdapter(importedStorage);
  const importedRecord = {
    format: 'typst-side-agent-sessions',
    version: 2,
    sessions: [{ id: 'imported', projectId: 'project', name: 'Imported', messages: [message] }]
  };
  assert.deepEqual(await sessionImport(importedRecord), { ok: true, imported: 1, rejected: 0 });
  const imported = await sessionGet((await sessionList('project'))[0].id);
  assert.equal(Object.hasOwn(imported.messages[0], 'editorStateUpdates'), false);
  assert.equal(Object.hasOwn(imported.messages[0], 'responseStatus'), false);
});

test('deleting a chat or project also removes its retained edit checkpoints', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const first = await sessionCreate('project-delete', 'First');
  const second = await sessionCreate('project-delete', 'Second');
  const third = await sessionCreate('project-keep', 'Third');
  for (const [id, session] of [['edit-first', first], ['edit-second', second], ['edit-third', third]]) {
    const beforeText = `before-${id}`;
    const afterText = `after-${id}`;
    await stageEditCheckpoint({
      id, projectId: session.projectId, sessionId: session.id, runId: `run-${id}`, callId: 'call',
      beforeText,
      beforeHash: await sha256Text(beforeText),
      pendingAfterHash: await sha256Text(afterText),
      pendingAfterLength: afterText.length
    });
    await commitEditCheckpoint(id);
  }

  await sessionDelete(first.id);
  assert.equal(await loadEditCheckpoint('edit-first'), null);
  assert.equal((await loadEditCheckpoint('edit-second')).status, 'applied');
  await sessionDeleteByProject('project-delete');
  assert.equal(await loadEditCheckpoint('edit-second'), null);
  assert.equal((await loadEditCheckpoint('edit-third')).status, 'applied');
});

test('manual document snapshots are file-scoped, deduplicated, and survive chat deletion', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const session = await sessionCreate('project-snapshots', 'Snapshots');

  const automatic = await createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC,
    projectId: session.projectId,
    sessionId: session.id,
    runId: 'run-one',
    fileLabel: 'main.typ',
    text: '= Saved'
  });
  const promoted = await createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.MANUAL,
    projectId: session.projectId,
    fileLabel: 'main.typ',
    text: '= Saved'
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.snapshot.id, automatic.snapshot.id);
  assert.equal(promoted.snapshot.kind, DOCUMENT_SNAPSHOT_KINDS.MANUAL);

  const duplicate = await createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.MANUAL,
    projectId: session.projectId,
    fileLabel: 'main.typ',
    text: '= Saved'
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.snapshot.id, promoted.snapshot.id);

  const laterAutomatic = await createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC,
    projectId: session.projectId,
    sessionId: session.id,
    runId: 'run-two',
    fileLabel: 'main.typ',
    text: '= Later'
  });
  assert.deepEqual(
    (await listDocumentSnapshots({ projectId: session.projectId, fileLabel: 'main.typ', sessionId: session.id })).map(item => item.kind).sort(),
    [DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC, DOCUMENT_SNAPSHOT_KINDS.MANUAL]
  );
  assert.deepEqual(await listDocumentSnapshots({ projectId: session.projectId, fileLabel: 'other.typ', sessionId: session.id }), []);

  await sessionDelete(session.id);
  assert.equal((await loadDocumentSnapshot(promoted.snapshot.id)).text, '= Saved');
  assert.equal(await loadDocumentSnapshot(laterAutomatic.snapshot.id), null);
  assert.equal(await deleteDocumentSnapshot({ id: promoted.snapshot.id, projectId: session.projectId }).then(result => result.removed), 1);
});

test('automatic snapshots replace the prior response and invalidate only after document divergence', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const first = await createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC,
    projectId: 'project', sessionId: 'chat', runId: 'run-one', fileLabel: 'main.typ', text: '= One'
  });
  const sameHash = await sha256Text('= One');
  assert.equal(await invalidateAutomaticDocumentSnapshots({
    projectId: 'project', sessionId: 'chat', fileLabel: 'main.typ', textHash: sameHash, textLength: '= One'.length
  }), 0);
  assert.ok(await loadDocumentSnapshot(first.snapshot.id));

  const second = await createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC,
    projectId: 'project', sessionId: 'chat', runId: 'run-two', fileLabel: 'main.typ', text: '= Two'
  });
  assert.equal(await loadDocumentSnapshot(first.snapshot.id), null);
  assert.equal((await listDocumentSnapshots({ projectId: 'project', fileLabel: 'main.typ', sessionId: 'chat' })).length, 1);

  assert.equal(await invalidateAutomaticDocumentSnapshots({
    projectId: 'project', sessionId: 'chat', fileLabel: 'other.typ', textHash: await sha256Text('different'), textLength: 'different'.length
  }), 0);
  assert.ok(await loadDocumentSnapshot(second.snapshot.id));
  assert.equal(await invalidateAutomaticDocumentSnapshots({
    projectId: 'project', sessionId: 'chat', fileLabel: 'main.typ', textHash: await sha256Text('= Changed'), textLength: '= Changed'.length
  }), 1);
  assert.equal(await loadDocumentSnapshot(second.snapshot.id), null);
  assert.equal(await deleteAutomaticDocumentSnapshots({ projectId: 'project', sessionId: 'chat' }), 0);
});

test('automatic snapshot retention never evicts manual recovery points', async () => {
  const storage = new FakeStorage();
  configureStorageAdapter(storage);
  const manualIds = [];
  for (let index = 0; index < LIMITS.MAX_DOCUMENT_SNAPSHOTS; index += 1) {
    const result = await createDocumentSnapshot({
      kind: DOCUMENT_SNAPSHOT_KINDS.MANUAL,
      projectId: 'project', fileLabel: 'main.typ', text: `manual-${index}`
    });
    manualIds.push(result.snapshot.id);
  }
  await assert.rejects(createDocumentSnapshot({
    kind: DOCUMENT_SNAPSHOT_KINDS.AUTOMATIC,
    projectId: 'project', sessionId: 'chat', runId: 'run', fileLabel: 'main.typ', text: 'automatic'
  }), error => error.code === 'DOCUMENT_SNAPSHOT_BUDGET_FULL');
  for (const id of manualIds) assert.ok(await loadDocumentSnapshot(id));
});
