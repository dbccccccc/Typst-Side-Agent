import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createArchive, listZipEntries } from '../../scripts/package-extension.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('packaged MV3 starts, bridges page context, streams locally, and sanitizes hostile chat content', { timeout: 90_000 }, async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'typst-side-agent-browser-'));
  const reviewedText = [
    '= Reviewed fixture',
    ...Array.from({ length: 27 }, (_, index) => `+ Reviewed line ${index + 2}`)
  ].join('\n');
  const secondReviewedText = reviewedText.replace('= Reviewed fixture', '= Second reviewed fixture');
  let context;
  try {
    const archivePath = resolve(temporary, 'extension.zip');
    const extensionPath = resolve(temporary, 'extension');
    await createArchive({ root, output: archivePath });
    await extractStoreZip(await readFile(archivePath), extensionPath);
    for (const required of ['manifest.json', 'PRIVACY.md', 'TESTING.md', 'src/sidepanel/index.html']) {
      await access(resolve(extensionPath, required), fsConstants.R_OK);
    }

    const launches = [];
    for (const executablePath of await browserCandidates()) {
      try {
        context = await chromium.launchPersistentContext(resolve(temporary, `profile-${launches.length}`), {
          executablePath,
          headless: true,
          serviceWorkers: 'allow',
          args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10_000 });
        if (!worker.url().startsWith('chrome-extension://')) throw new Error(`Unexpected worker URL: ${worker.url()}`);
        break;
      } catch (error) {
        launches.push(`${executablePath}: ${error.message}`);
        await context?.close().catch(() => {});
        context = null;
      }
    }
    if (!context) throw new Error(`No local Chromium executable loaded the MV3 extension. Attempts:\n${launches.join('\n')}`);

    let worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).host;
    const fixtureHtml = await readFile(resolve(root, 'test', 'fixtures', 'typst-page.html'), 'utf8');
    const remoteRequests = [];
    const modelRequests = [];
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'https://typst.app/project/browser-fixture') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml });
      } else if (url === 'https://model.fixture/v1/chat/completions') {
        const request = route.request().postDataJSON();
        modelRequests.push(request);
        if (request.model === 'fixture-title-model' && request.stream === false) {
          const titleRequestCount = modelRequests.filter(item => item.model === 'fixture-title-model').length;
          if (titleRequestCount === 3) {
            await new Promise(resolve => { setTimeout(resolve, 250); });
            await route.fulfill({
              status: 503,
              contentType: 'text/plain',
              body: 'Title service unavailable'
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              choices: [{ message: { content: titleRequestCount === 1 ? 'First edit request' : 'Second edit request' } }]
            })
          });
          return;
        }
        const latestUser = request.messages.slice().reverse().find(message =>
          message.role === 'user' && typeof message.content === 'string'
        )?.content;
        const fileTreeToolResult = request.messages.some(message =>
          message.role === 'tool' && message.tool_call_id === 'browser-file-tree'
        );
        const editFixture = latestUser === 'Make a reviewed edit'
          ? {
              callId: 'browser-edit-first',
              search: '= Browser fixture',
              replace: reviewedText,
              reply: 'Applied first reviewed edit'
            }
          : latestUser === 'Make a second edit'
            ? {
                callId: 'browser-edit-second',
                search: reviewedText,
                replace: secondReviewedText,
                reply: 'Applied second reviewed edit'
              }
            : null;
        let delta;
        if (request.model === 'fixture-files-model' && !fileTreeToolResult) {
          delta = {
            tool_calls: [{
              index: 0,
              id: 'browser-file-tree',
              type: 'function',
              function: { name: 'read_file_structure', arguments: '{}' }
            }]
          };
        } else if (request.model === 'fixture-files-model') {
          delta = { content: 'Explicit file structure read' };
        } else if (
          request.model === 'fixture-edit-model' &&
          editFixture &&
          !request.messages.some(message => message.role === 'tool' && message.tool_call_id === editFixture.callId)
        ) {
          delta = {
            tool_calls: [{
              index: 0,
              id: editFixture.callId,
              type: 'function',
              function: {
                name: 'search_replace',
                arguments: JSON.stringify({ search: editFixture.search, replace: editFixture.replace })
              }
            }]
          };
        } else {
          delta = { content: request.model === 'fixture-edit-model' ? editFixture?.reply || 'Revert context received' : 'Local streamed reply' };
        }
        const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
      } else if (url.startsWith('chrome-extension://') || url.startsWith('data:') || url.startsWith('blob:')) {
        await route.continue();
      } else {
        remoteRequests.push(url);
        await route.abort();
      }
    });

    const fixturePage = await context.newPage();
    await fixturePage.goto('https://typst.app/project/browser-fixture');
    await fixturePage.waitForSelector('.cm-content');
    await fixturePage.waitForTimeout(250);
    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url === 'https://typst.app/project/browser-fixture')?.id;
    });
    assert.ok(Number.isInteger(tabId));

    const panelErrors = [];
    const panel = await context.newPage();
    panel.on('pageerror', error => panelErrors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await panel.waitForSelector('#messages', { state: 'attached' });
    await panel.waitForSelector('#settings-panel:not(.collapsed)');
    await panel.locator('.settings-tab[data-tab="general"]').click();

    const sendShortcut = panel.locator('#send-message-shortcut');
    assert.equal(await sendShortcut.inputValue(), 'enter');
    assert.deepEqual(await sendShortcut.locator('option').allTextContents(), [
      'Enter', 'Shift + Enter', 'Ctrl + Enter'
    ]);
    await sendShortcut.selectOption('ctrl-enter');
    await panel.locator('#save-general-settings').click();
    await panel.waitForFunction(() => document.getElementById('send-shortcut-hint')?.textContent === 'Ctrl + Enter');
    const savedSendShortcut = await panel.evaluate(async () => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
      const stored = protocol.unwrapResponse(await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.LOAD_SETTINGS)));
      return {
        state: stateModule.state.settings.sendMessageShortcut,
        stored: stored.sendMessageShortcut,
        buttonLabel: document.getElementById('send-btn')?.getAttribute('aria-label')
      };
    });
    assert.deepEqual(savedSendShortcut, {
      state: 'ctrl-enter',
      stored: 'ctrl-enter',
      buttonLabel: 'Send message (Ctrl + Enter)'
    });

    await panel.locator('#about-settings-button').click();
    await panel.waitForSelector('#about-dialog-layer:not(.hidden)');
    const settingsAbout = await panel.evaluate(() => {
      const layer = document.getElementById('about-dialog-layer');
      const links = [...layer.querySelectorAll('.about-resource-link')];
      return {
        title: document.getElementById('about-dialog-title')?.textContent,
        version: document.getElementById('about-dialog-version')?.textContent,
        expectedVersion: `Version ${chrome.runtime.getManifest().version}`,
        hrefs: links.map(link => link.href),
        storeHref: document.getElementById('about-chrome-store-link')?.href,
        initialFocus: document.activeElement?.id,
        modal: layer.querySelector('[role="dialog"]')?.getAttribute('aria-modal')
      };
    });
    const expectedStoreHref = 'https://chromewebstore.google.com/detail/eljacjoifoamnmbclmhlpcdabdioleab';
    assert.equal(settingsAbout.title, 'About Typst Side Agent');
    assert.equal(settingsAbout.version, settingsAbout.expectedVersion);
    assert.deepEqual(settingsAbout.hrefs, [
      'https://github.com/dbccccccc/Typst-Side-Agent',
      'https://forum.typst.app/u/dbcccc/summary',
      expectedStoreHref
    ]);
    assert.equal(settingsAbout.storeHref, expectedStoreHref);
    assert.equal(settingsAbout.initialFocus, 'about-dialog-close');
    assert.equal(settingsAbout.modal, 'true');
    await panel.locator('#about-dialog-close').click();
    await panel.waitForFunction(() => document.getElementById('about-dialog-layer')?.classList.contains('hidden'));
    assert.equal(await panel.evaluate(() => document.activeElement?.id), 'about-settings-button');

    await panel.getByRole('button', { name: 'Close settings' }).click();
    await panel.waitForSelector('#settings-panel.collapsed');

    await panel.locator('#about-icon-button').click();
    await panel.waitForSelector('#about-dialog-layer:not(.hidden)');
    await panel.keyboard.press('Escape');
    await panel.waitForFunction(() => document.getElementById('about-dialog-layer')?.classList.contains('hidden'));
    assert.equal(await panel.evaluate(() => document.activeElement?.id), 'about-icon-button');

    const composerInput = panel.locator('#user-input');
    await composerInput.evaluate(input => { input.disabled = false; });
    await composerInput.fill('Keyboard shortcut check');
    await composerInput.press('Enter');
    assert.equal(await composerInput.inputValue(), 'Keyboard shortcut check\n');
    await composerInput.press('Shift+Enter');
    assert.equal(await composerInput.inputValue(), 'Keyboard shortcut check\n\n');
    await composerInput.press('Control+Enter');
    assert.equal(await composerInput.inputValue(), 'Keyboard shortcut check\n\n');
    await composerInput.fill('');

    await panel.evaluate(async () => {
      const status = await import(chrome.runtime.getURL('src/sidepanel/status-controller.js'));
      status.setStatus('Copyable browser failure', true, 5_000);
    });
    await panel.waitForSelector('#status.is-visible');
    const statusToast = await panel.evaluate(() => {
      const toast = document.getElementById('status');
      const region = document.getElementById('status-region');
      const composer = document.querySelector('.composer');
      const toastRect = toast.getBoundingClientRect();
      return {
        message: document.getElementById('status-message')?.textContent,
        role: toast.getAttribute('role'),
        isError: toast.classList.contains('is-error'),
        hasCopy: !!document.getElementById('status-copy'),
        hasClose: !!document.getElementById('status-close'),
        aboveComposer: toastRect.bottom < composer.getBoundingClientRect().top,
        inTopRegion: toast.parentElement === region,
        removedFromComposer: !composer.contains(toast)
      };
    });
    assert.deepEqual(statusToast, {
      message: 'Copyable browser failure',
      role: 'alert',
      isError: true,
      hasCopy: true,
      hasClose: true,
      aboveComposer: true,
      inTopRegion: true,
      removedFromComposer: true
    });
    await panel.getByRole('button', { name: 'Dismiss notification' }).click();
    await panel.waitForFunction(() => document.getElementById('status')?.classList.contains('hidden'));
    await panel.evaluate(async () => {
      const status = await import(chrome.runtime.getURL('src/sidepanel/status-controller.js'));
      status.setStatus('Temporary browser info', false, 80);
    });
    await panel.waitForSelector('#status.is-visible');
    await panel.waitForFunction(() => document.getElementById('status')?.classList.contains('hidden'));

    const permissionTrigger = panel.locator('#editor-permission-btn');
    const askPermission = panel.locator('[data-editor-approval-mode="ask"]');
    const autoPermission = panel.locator('[data-editor-approval-mode="auto"]');
    const permissionPlacement = await panel.evaluate(() => {
      const contextBar = document.querySelector('.context-bar');
      const contextButton = document.getElementById('add-context-btn');
      const permission = document.querySelector('.editor-permission-wrap');
      const toolbar = document.querySelector('.composer-toolbar');
      return {
        inToolbar: !!toolbar?.contains(permission),
        besideContext: !!contextBar?.contains(contextButton) && !!contextBar?.contains(permission),
        contextComesFirst: !!(contextButton?.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING),
        oldStandaloneRowRemoved: !document.querySelector('.editor-permission-row')
      };
    });
    assert.deepEqual(permissionPlacement, {
      inToolbar: true,
      besideContext: true,
      contextComesFirst: true,
      oldStandaloneRowRemoved: true
    });
    assert.equal(await permissionTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.locator('#editor-permission-current').textContent(), 'Ask');
    await permissionTrigger.click();
    await panel.waitForSelector('#editor-permission-menu:not(.hidden)');
    assert.equal(await permissionTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await askPermission.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await panel.locator('.editor-permission-option .opt-title').allTextContents(), [
      'Ask before applying', 'Auto approve'
    ]);
    assert.deepEqual(await panel.locator('.editor-permission-option .opt-hint').allTextContents(), [
      'Review each proposed document change before it is applied.',
      'Apply built-in document edits immediately. External tools keep their own approval rules.'
    ]);
    await autoPermission.click();
    await panel.waitForFunction(() => document.getElementById('editor-permission-menu')?.classList.contains('hidden'));
    await waitForSavedEditorApprovalMode(panel, 'auto');
    assert.equal(await autoPermission.getAttribute('aria-checked'), 'true');
    assert.equal(await panel.locator('#editor-permission-current').textContent(), 'Auto');
    await panel.waitForFunction(() => !document.getElementById('editor-permission-btn')?.disabled);
    await permissionTrigger.click();
    await askPermission.click();
    await waitForSavedEditorApprovalMode(panel, 'ask');
    assert.equal(await askPermission.getAttribute('aria-checked'), 'true');
    assert.equal(await panel.locator('#editor-permission-current').textContent(), 'Ask');

    const cleanButtonStyles = await panel.evaluate(() => {
      const primary = getComputedStyle(document.querySelector('.btn-primary'));
      const send = getComputedStyle(document.getElementById('send-btn'));
      return {
        primaryBackgroundImage: primary.backgroundImage,
        primaryBoxShadow: primary.boxShadow,
        sendBackgroundImage: send.backgroundImage,
        sendBoxShadow: send.boxShadow
      };
    });
    assert.equal(cleanButtonStyles.primaryBackgroundImage, 'none');
    assert.equal(cleanButtonStyles.primaryBoxShadow, 'none');
    assert.equal(cleanButtonStyles.sendBackgroundImage, 'none');
    assert.equal(cleanButtonStyles.sendBoxShadow, 'none');

    const editorContext = await panel.evaluate(async tabIdValue => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.GET_EDITOR_CONTEXT, { tabId: tabIdValue }));
      return protocol.unwrapResponse(response);
    }, tabId);
    assert.equal(editorContext.fullText, '= Browser fixture');
    assert.deepEqual(editorContext.workspace?.active_editor_file, {
      projectLabel: 'Browser project',
      relativePath: 'ref.bib',
      basename: 'ref.bib',
      source: 'header_breadcrumb',
      confidence: 'high'
    });
    assert.equal(Object.hasOwn(editorContext.workspace || {}, 'project_file_tree'), false);

    const fileTreeContext = await panel.evaluate(async tabIdValue => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.GET_EDITOR_CONTEXT, {
        tabId: tabIdValue,
        projection: 'identity'
      }));
      return protocol.unwrapResponse(response);
    }, tabId);
    assert.equal(fileTreeContext.workspace?.files_panel_open, true);
    assert.deepEqual(fileTreeContext.workspace?.project_file_tree, {
      source: 'files_panel_dom',
      entries: [
        { path: 'chapters', kind: 'folder', state: 'expanded' },
        { path: 'chapters/intro.typ', kind: 'file' },
        { path: 'chapters/drafts', kind: 'folder', state: 'collapsed' },
        { path: 'ref.bib', kind: 'file' }
      ],
      truncated: false
    });

    const fileTreeRun = await panel.evaluate(async ({ tabId: tabIdValue }) => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const runId = protocol.createRunId();
      const events = [];
      const listener = message => { if (message.runId === runId) events.push(message); };
      chrome.runtime.onMessage.addListener(listener);
      protocol.unwrapResponse(await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.AI_RUN_RESERVE, {
        tabId: tabIdValue,
        projectId: 'browser-fixture',
        sessionId: 'browser-file-tree-session'
      }, { runId })));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.AI_STREAM_START, {
        tabId: tabIdValue,
        projectId: 'browser-fixture',
        sessionId: 'browser-file-tree-session',
        messages: [{ role: 'user', content: 'Inspect files explicitly' }],
        settings: { maxHistoryMessages: 40 },
        modelConfig: { apiBaseUrl: 'https://model.fixture/v1', apiKey: 'fixture', modelId: 'fixture-files-model' },
        attachments: {}
      }, { runId }));
      chrome.runtime.onMessage.removeListener(listener);
      return { result: protocol.unwrapResponse(response), events };
    }, { tabId });
    assert.equal(fileTreeRun.result.ok, true);
    const browserTreeResult = fileTreeRun.events.find(event =>
      event.type === 'AI_TOOL_RESULT' && event.payload.name === 'read_file_structure'
    )?.payload.result;
    assert.equal(browserTreeResult.ok, true);
    assert.ok(browserTreeResult.entries.some(entry => entry.path === 'chapters/intro.typ'));
    assert.deepEqual(browserTreeResult.collapsed_folders, ['chapters/drafts']);

    const runResult = await panel.evaluate(async ({ tabId: tabIdValue }) => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const runId = protocol.createRunId();
      const events = [];
      const listener = message => { if (message.runId === runId) events.push(message); };
      chrome.runtime.onMessage.addListener(listener);
      protocol.unwrapResponse(await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.AI_RUN_RESERVE, {
        tabId: tabIdValue,
        projectId: 'browser-fixture',
        sessionId: 'browser-session'
      }, { runId })));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.AI_STREAM_START, {
        tabId: tabIdValue,
        projectId: 'browser-fixture',
        sessionId: 'browser-session',
        messages: [{ role: 'user', content: 'Respond locally' }],
        settings: { maxHistoryMessages: 40 },
        modelConfig: { apiBaseUrl: 'https://model.fixture/v1', apiKey: 'fixture', modelId: 'fixture-model' },
        attachments: {}
      }, { runId }));
      chrome.runtime.onMessage.removeListener(listener);
      return { result: protocol.unwrapResponse(response), events };
    }, { tabId });
    assert.equal(runResult.result.ok, true);
    assert.ok(runResult.events.some(event => event.type === 'AI_STREAM_BATCH' && event.payload.items.some(item => item.text.includes('Local streamed reply'))));
    assert.equal(runResult.events.at(-1).type, 'AI_STREAM_DONE');

    const browserSession = await panel.evaluate(async tabIdValue => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
      const created = protocol.unwrapResponse(await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.SESSION_CREATE, {
        projectId: 'browser-fixture',
        name: 'New chat'
      })));
      stateModule.state.activeTabOnTypst = true;
      stateModule.state.activeTabId = tabIdValue;
      stateModule.state.currentProjectId = 'browser-fixture';
      stateModule.state.currentSession = created;
      stateModule.state.chatHistory = [];
      stateModule.state.settings = {
        systemPrompt: '',
        models: [
          {
            id: 'fixture-edit',
            name: 'Fixture edit',
            apiBaseUrl: 'https://model.fixture/v1',
            apiKey: 'fixture',
            modelId: 'fixture-edit-model'
          },
          {
            id: 'fixture-title',
            name: 'Fixture title',
            apiBaseUrl: 'https://model.fixture/v1',
            apiKey: 'fixture',
            modelId: 'fixture-title-model'
          }
        ],
        activeModelId: 'fixture-edit',
        maxHistoryMessages: 40,
        autoNameModelId: 'fixture-title',
        editorApprovalMode: 'ask'
      };
      const input = document.getElementById('user-input');
      input.disabled = false;
      input.value = 'Make a reviewed edit';
      document.getElementById('send-btn').disabled = false;
      return created;
    }, tabId);
    assert.equal(browserSession.projectId, 'browser-fixture');
    await worker.evaluate(tabIdValue => chrome.tabs.update(tabIdValue, { active: true }), tabId);
    await panel.evaluate(() => {
      const send = document.getElementById('send-btn');
      send.click();
      send.click();
    });
    try {
      await panel.waitForSelector('.tool-edit-approval .edit-diff', { timeout: 10_000 });
    } catch (error) {
      const diagnostics = await panel.evaluate(async () => {
        const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
        return {
          status: document.getElementById('status')?.textContent || '',
          messages: document.getElementById('messages')?.innerText || '',
          activeRun: stateModule.state.activeRun,
          activeTabOnTypst: stateModule.state.activeTabOnTypst,
          activeTabId: stateModule.state.activeTabId,
          currentProjectId: stateModule.state.currentProjectId,
          currentSessionId: stateModule.state.currentSession?.id || null,
          isStreaming: stateModule.state.isStreaming
        };
      });
      diagnostics.panelErrors = [...panelErrors];
      throw new Error(`Diff approval did not appear: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    await panel.waitForFunction(() => document.getElementById('session-name')?.textContent === 'First edit request');
    const firstEditRequest = modelRequests.find(request => request.model === 'fixture-edit-model' &&
      request.messages.some(message => message.role === 'user' && message.content === 'Make a reviewed edit'));
    assert.equal(firstEditRequest?.messages.some(message =>
      typeof message.content === 'string' && message.content.includes('chapters/intro.typ')
    ), false, 'normal user sends do not inject the file tree');
    const firstAutoNameState = await panel.evaluate(async () => {
      const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
      return {
        activeRun: !!stateModule.state.activeRun,
        historyRoles: stateModule.state.chatHistory.map(message => message.role),
        title: stateModule.state.currentSession?.name
      };
    });
    assert.deepEqual(firstAutoNameState, {
      activeRun: true,
      historyRoles: ['user'],
      title: 'First edit request'
    });
    const diffShape = await panel.evaluate(() => ({
      file: document.querySelector('.edit-diff-file')?.textContent,
      additions: document.querySelector('.edit-diff-additions')?.textContent,
      deletions: document.querySelector('.edit-diff-deletions')?.textContent,
      removed: document.querySelector('.edit-diff-delete .edit-diff-code')?.textContent,
      inserted: document.querySelector('.edit-diff-insert .edit-diff-code')?.textContent,
      buttons: [...document.querySelectorAll('.tool-edit-approval button')].map(button => button.textContent)
    }));
    assert.equal(diffShape.additions, '+28');
    assert.equal(diffShape.deletions, '−1');
    assert.equal(diffShape.removed, '= Browser fixture');
    assert.equal(diffShape.inserted, '= Reviewed fixture');
    assert.deepEqual(diffShape.buttons, ['Apply changes', 'Reject']);
    const preparedUserMessages = await panel.evaluate(async () => {
      const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
      return stateModule.state.chatHistory.filter(message => message.role === 'user' && message.content === 'Make a reviewed edit').length;
    });
    assert.equal(preparedUserMessages, 1);
    await fixturePage.waitForSelector('#typst-side-agent-inline-diff-rows .tsa-inline-diff-surface');
    const inlineDiffShape = await fixturePage.evaluate(() => {
      const line = document.querySelector('.cm-line');
      const layer = document.getElementById('typst-side-agent-inline-diff-rows');
      const surface = layer?.querySelector('.tsa-inline-diff-surface');
      const scroller = document.querySelector('.cm-scroller');
      const addedRows = [...document.querySelectorAll('.tsa-inline-diff-row.tsa-inline-diff-insert')];
      const deletedRows = [...document.querySelectorAll('.tsa-inline-diff-row.tsa-inline-diff-delete')];
      const allRows = [...document.querySelectorAll('.tsa-inline-diff-row')];
      const surfaceRect = surface?.getBoundingClientRect();
      const scrollerRect = scroller?.getBoundingClientRect();
      const rowRects = allRows.map(row => row.getBoundingClientRect());
      const lineNumbers = row => [...row.querySelectorAll('.tsa-inline-diff-line-number')].map(number => number.textContent);
      return {
        floatingLayer: Boolean(document.getElementById('typst-side-agent-inline-diff')),
        presentationLayer: Boolean(layer),
        surfaceRole: surface?.getAttribute('role'),
        surfaceLabel: surface?.getAttribute('aria-label'),
        surfaceMatchesEditor: Boolean(surfaceRect && scrollerRect &&
          Math.abs(surfaceRect.left - scrollerRect.left) < 1 &&
          Math.abs(surfaceRect.top - scrollerRect.top) < 1 &&
          Math.abs(surfaceRect.width - scrollerRect.width) < 1 &&
          Math.abs(surfaceRect.height - scrollerRect.height) < 1),
        surfacePointerEvents: surface ? getComputedStyle(surface).pointerEvents : '',
        editorBackground: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor,
        surfaceBackground: surface ? getComputedStyle(surface).backgroundColor : '',
        insertedRowBackground: addedRows[0] ? getComputedStyle(addedRows[0]).backgroundColor : '',
        deletedRowBackground: deletedRows[0] ? getComputedStyle(deletedRows[0]).backgroundColor : '',
        sourceText: line?.textContent,
        addedRowCount: addedRows.length,
        addedRowTexts: addedRows.map(row => row.querySelector('.tsa-inline-diff-code')?.textContent),
        firstAddedLineNumbers: lineNumbers(addedRows[0]),
        lastAddedLineNumbers: lineNumbers(addedRows.at(-1)),
        addedMarkers: addedRows.map(row => row.querySelector('.tsa-inline-diff-marker')?.textContent),
        deletedRowCount: deletedRows.length,
        deletedRowText: deletedRows[0]?.querySelector('.tsa-inline-diff-code')?.textContent,
        renderedAddedRows: addedRows.filter(row => {
          const rect = row.getBoundingClientRect();
          return getComputedStyle(row).display !== 'none' && rect.width > 0 && rect.height > 0;
        }).length,
        rowsDoNotOverlap: rowRects.every((rect, index) => index === 0 || rect.top >= rowRects[index - 1].bottom - 0.5),
        underlyingHasPreviewClasses: Boolean(document.querySelector('.cm-line[class*="tsa-inline"], .cm-gutterElement[class*="tsa-inline"]')),
        lineHeight: line?.getBoundingClientRect().height,
        headerStats: document.querySelector('.tsa-inline-diff-stats')?.textContent
      };
    });
    assert.equal(inlineDiffShape.floatingLayer, false);
    assert.equal(inlineDiffShape.presentationLayer, true);
    assert.equal(inlineDiffShape.surfaceRole, 'region');
    assert.match(inlineDiffShape.surfaceLabel, /^Proposed changes to .+/);
    assert.equal(inlineDiffShape.surfaceMatchesEditor, true);
    assert.equal(inlineDiffShape.surfacePointerEvents, 'auto');
    assert.equal(inlineDiffShape.editorBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(inlineDiffShape.surfaceBackground, 'rgb(25, 24, 31)');
    assert.equal(inlineDiffShape.insertedRowBackground, 'rgb(25, 24, 31)');
    assert.equal(inlineDiffShape.deletedRowBackground, 'rgb(25, 24, 31)');
    assert.equal(inlineDiffShape.sourceText, '= Browser fixture');
    assert.equal(inlineDiffShape.addedRowCount, 28);
    assert.equal(inlineDiffShape.renderedAddedRows, 28);
    assert.deepEqual(inlineDiffShape.addedRowTexts, reviewedText.split('\n'));
    assert.deepEqual(inlineDiffShape.firstAddedLineNumbers, ['', '1']);
    assert.deepEqual(inlineDiffShape.lastAddedLineNumbers, ['', '28']);
    assert.ok(inlineDiffShape.addedMarkers.every(marker => marker === '+'));
    assert.equal(inlineDiffShape.deletedRowCount, 1);
    assert.equal(inlineDiffShape.deletedRowText, '= Browser fixture');
    assert.equal(inlineDiffShape.rowsDoNotOverlap, true);
    assert.equal(inlineDiffShape.underlyingHasPreviewClasses, false);
    assert.ok(inlineDiffShape.lineHeight < 30);
    assert.equal(inlineDiffShape.headerStats, '+28−1');
    await panel.getByRole('button', { name: 'Apply changes' }).click();
    await fixturePage.waitForFunction(expected => document.querySelector('.cm-content')?.textContent === expected, reviewedText);
    await fixturePage.waitForFunction(() => !document.getElementById('typst-side-agent-inline-diff-rows'));
    await panel.waitForSelector('.tool-status-ok');
    await panel.waitForSelector('.edit-revert-button', { timeout: 10_000 });
    assert.equal(await panel.locator('.edit-revert-button').count(), 1);
    assert.equal(await panel.locator('.response-snapshot-button').count(), 1);

    await panel.waitForSelector('#send-btn:not([disabled])');
    await panel.evaluate(() => {
      const input = document.getElementById('user-input');
      input.value = 'Make a second edit';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send-btn').click();
    });
    await panel.waitForSelector('.tool-edit-approval .edit-diff', { timeout: 10_000 });
    await panel.waitForFunction(() => document.getElementById('session-name')?.textContent === 'Second edit request');
    assert.equal(modelRequests.filter(request => request.model === 'fixture-title-model').length, 2);
    await panel.getByRole('button', { name: 'Apply changes' }).click();
    await fixturePage.waitForFunction(expected => document.querySelector('.cm-content')?.textContent === expected, secondReviewedText);
    await panel.waitForFunction(() => document.querySelectorAll('.edit-revert-button').length === 2);
    assert.equal(await panel.locator('.response-snapshot-button').count(), 1);

    const originalPanelViewport = panel.viewportSize();
    await panel.setViewportSize({ width: 360, height: 720 });
    const revertUi = await panel.locator('.edit-revert-control').first().evaluate(control => {
      const button = control.querySelector('.edit-revert-button');
      const controlStyle = getComputedStyle(control);
      const buttonStyle = getComputedStyle(button);
      return {
        state: control.dataset.revertState,
        display: controlStyle.display,
        borderWidth: Number.parseFloat(controlStyle.borderTopWidth),
        buttonHeight: Number.parseFloat(buttonStyle.height),
        buttonLabel: button.textContent.trim(),
        tooltip: button.title,
        hasActionIcon: !!button.querySelector('svg'),
        ariaBusy: control.getAttribute('aria-busy')
      };
    });
    assert.equal(revertUi.state, 'available');
    assert.equal(revertUi.display, 'flex');
    assert.equal(revertUi.borderWidth, 0);
    assert.ok(revertUi.buttonHeight <= 28, JSON.stringify(revertUi));
    assert.equal(revertUi.buttonLabel, 'Revert');
    assert.match(revertUi.tooltip, /later agent edits/i);
    assert.equal(revertUi.hasActionIcon, true);
    assert.equal(revertUi.ariaBusy, 'false');

    await panel.locator('.response-snapshot-button').click();
    await panel.waitForSelector('#snapshot-menu:not(.hidden)');
    const snapshotUi = await panel.locator('#snapshot-menu').evaluate(menu => ({
      heading: menu.querySelector('.snapshot-menu-heading strong')?.textContent,
      footer: menu.querySelector('.snapshot-menu-footer')?.textContent,
      createButtons: menu.querySelectorAll('#snapshot-create').length,
      responseSnapshots: menu.querySelectorAll('.snapshot-item.is-automatic').length
    }));
    assert.equal(snapshotUi.heading, 'Document snapshot');
    assert.match(snapshotUi.footer, /completed response/i);
    assert.equal(snapshotUi.createButtons, 0);
    assert.equal(snapshotUi.responseSnapshots, 1);

    await panel.locator('.snapshot-delete-action').first().click();
    await panel.waitForSelector('#snapshot-dialog-layer:not(.hidden)');
    const deleteDialog = await panel.locator('#snapshot-dialog-layer').evaluate(layer => ({
      mode: layer.dataset.dialogMode,
      title: layer.querySelector('#snapshot-dialog-title')?.textContent,
      message: layer.querySelector('#snapshot-dialog-body')?.textContent,
      action: layer.querySelector('#snapshot-dialog-confirm')?.textContent,
      destructive: layer.querySelector('#snapshot-dialog-confirm')?.classList.contains('btn-danger'),
      menuHidden: document.getElementById('snapshot-menu')?.classList.contains('hidden')
    }));
    assert.equal(deleteDialog.mode, 'delete');
    assert.equal(deleteDialog.title, 'Delete this snapshot?');
    assert.match(deleteDialog.message, /cannot be restored/i);
    assert.equal(deleteDialog.action, 'Delete');
    assert.equal(deleteDialog.destructive, true);
    assert.equal(deleteDialog.menuHidden, true);
    await panel.locator('#snapshot-dialog-cancel').click();
    await panel.waitForFunction(() => document.getElementById('snapshot-dialog-layer')?.classList.contains('hidden'));

    await panel.locator('.response-snapshot-button').click();
    await panel.waitForSelector('#snapshot-menu:not(.hidden)');
    await panel.locator('.snapshot-delete-action').first().click();
    await panel.locator('#snapshot-dialog-confirm').click();
    await panel.waitForFunction(() => document.getElementById('snapshot-dialog-layer')?.classList.contains('hidden'));
    await panel.waitForSelector('#snapshot-menu:not(.hidden)');
    assert.equal(await panel.locator('.snapshot-item.is-automatic').count(), 0);
    await panel.locator('#snapshot-menu-close').click();

    await panel.locator('.edit-revert-button').first().click();
    await panel.waitForSelector('#revert-dialog-layer:not(.hidden)');
    const revertDialog = await panel.locator('#revert-dialog-layer').evaluate(layer => ({
      title: layer.querySelector('#revert-dialog-title')?.textContent,
      subtitle: layer.querySelector('#revert-dialog-subtitle')?.textContent,
      message: layer.querySelector('#revert-dialog-body')?.textContent,
      action: layer.querySelector('#revert-dialog-confirm')?.textContent,
      modal: layer.querySelector('[role="dialog"]')?.getAttribute('aria-modal'),
      expanded: document.querySelector('.edit-revert-button')?.getAttribute('aria-expanded')
    }));
    assert.equal(revertDialog.title, 'Revert these changes?');
    assert.equal(revertDialog.subtitle, 'ref.bib');
    assert.match(revertDialog.message, /later agent edits/i);
    assert.match(revertDialog.message, /newest to oldest/i);
    assert.equal(revertDialog.action, 'Revert changes');
    assert.equal(revertDialog.modal, 'true');
    assert.equal(revertDialog.expanded, 'true');
    assert.equal(await fixturePage.locator('.cm-content').textContent(), secondReviewedText);
    await panel.locator('#revert-dialog-cancel').click();
    await panel.waitForFunction(() => document.getElementById('revert-dialog-layer')?.classList.contains('hidden'));
    assert.equal(await fixturePage.locator('.cm-content').textContent(), secondReviewedText);

    await panel.locator('.edit-revert-button').first().click();
    await panel.waitForSelector('#revert-dialog-layer:not(.hidden)');
    await panel.locator('#revert-dialog-confirm').click();
    await panel.waitForFunction(() => document.getElementById('revert-dialog-layer')?.classList.contains('hidden'));
    await fixturePage.waitForFunction(() => document.querySelector('.cm-content')?.textContent === '= Browser fixture');
    await panel.waitForFunction(() => document.querySelectorAll('.edit-revert-success').length === 2 || document.querySelector('.edit-revert-error'));
    const revertOutcome = await panel.evaluate(() => ({
      successes: [...document.querySelectorAll('.edit-revert-success')].map(element => element.textContent),
      error: document.querySelector('.edit-revert-error')?.textContent || '',
      footers: [...document.querySelectorAll('.edit-revert-control')].map(element => element.textContent),
      states: [...document.querySelectorAll('.edit-revert-control')].map(element => element.dataset.revertState),
      roles: [...document.querySelectorAll('.edit-revert-control')].map(element => element.getAttribute('role')),
      successIcons: document.querySelectorAll('.edit-revert-status.is-success .response-action-icon svg').length,
      snapshotButtons: document.querySelectorAll('.response-snapshot-button').length
    }));
    assert.deepEqual(revertOutcome.successes, ['Changes reverted', 'Changes reverted'], JSON.stringify(revertOutcome));
    assert.equal(revertOutcome.error, '', JSON.stringify(revertOutcome));
    assert.deepEqual(revertOutcome.states, ['success', 'success'], JSON.stringify(revertOutcome));
    assert.deepEqual(revertOutcome.roles, [null, null], JSON.stringify(revertOutcome));
    assert.equal(revertOutcome.successIcons, 2, JSON.stringify(revertOutcome));
    assert.equal(revertOutcome.snapshotButtons, 1, JSON.stringify(revertOutcome));
    assert.equal(await panel.locator('.edit-revert-button').count(), 0);
    if (originalPanelViewport) await panel.setViewportSize(originalPanelViewport);

    const revertedSession = await panel.evaluate(async sessionId => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.SESSION_GET, { sessionId }));
        const session = protocol.unwrapResponse(response);
        const revertedCount = session?.messages?.reduce((count, message) => count + (message?.segments || []).reduce(
          (segmentCount, segment) => segmentCount + (segment?.type === 'tools' ? (segment.calls || []).filter(call =>
            segment.results?.[call.id]?.editCheckpoint?.status === 'reverted'
          ).length : 0),
          0
        ), 0) || 0;
        if (revertedCount >= 2) return session;
        await new Promise(resolve => { setTimeout(resolve, 50); });
      }
      throw new Error('Reverted checkpoint status was not persisted to the session.');
    }, browserSession.id);

    const modelRequestCount = modelRequests.length;
    const postRevertRun = await panel.evaluate(async ({ tabId: tabIdValue, sessionId, messages }) => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const runId = protocol.createRunId();
      protocol.unwrapResponse(await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.AI_RUN_RESERVE, {
        tabId: tabIdValue,
        projectId: 'browser-fixture',
        sessionId
      }, { runId })));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.AI_STREAM_START, {
        tabId: tabIdValue,
        projectId: 'browser-fixture',
        sessionId,
        messages: [...messages, { role: 'user', content: 'Confirm reverted context' }],
        settings: { maxHistoryMessages: 40 },
        modelConfig: { apiBaseUrl: 'https://model.fixture/v1', apiKey: 'fixture', modelId: 'fixture-edit-model' },
        attachments: {}
      }, { runId }));
      return protocol.unwrapResponse(response);
    }, { tabId, sessionId: browserSession.id, messages: revertedSession.messages });
    assert.equal(postRevertRun.ok, true);
    assert.equal(modelRequests.length, modelRequestCount + 1);
    const postRevertMessages = modelRequests.at(-1).messages;
    const revertStateIndexes = postRevertMessages.flatMap((message, index) =>
      message.role === 'system' && /successfully reverted all Typst editor changes/i.test(message.content) ? [index] : []
    );
    const editedResponseIndexes = ['Applied first reviewed edit', 'Applied second reviewed edit'].map(content =>
      postRevertMessages.findIndex(message => message.role === 'assistant' && message.content === content)
    );
    const nextUserIndex = postRevertMessages.findIndex(message => message.content === 'Confirm reverted context');
    assert.deepEqual(revertStateIndexes, editedResponseIndexes.map(index => index + 1), 'each revert state follows its affected response');
    assert.ok(nextUserIndex > revertStateIndexes.at(-1), 'the next user turn follows both revert state events');

    await panel.waitForSelector('#send-btn:not([disabled])');
    await panel.evaluate(() => {
      const input = document.getElementById('user-input');
      input.value = 'Keep working even if naming fails';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send-btn').click();
    });
    await panel.waitForSelector('#status.is-visible.is-error');
    const autoNameFailure = await panel.locator('#status').evaluate(status => ({
      message: document.getElementById('status-message')?.textContent,
      role: status.getAttribute('role'),
      copyAction: document.getElementById('status-copy')?.getAttribute('aria-label'),
      regionContainsToast: document.getElementById('status-region')?.contains(status)
    }));
    assert.match(autoNameFailure.message, /chat auto-name failed/i);
    assert.match(autoNameFailure.message, /API 503: Title service unavailable/i);
    assert.equal(autoNameFailure.role, 'alert');
    assert.equal(autoNameFailure.copyAction, 'Copy notification message');
    assert.equal(autoNameFailure.regionContainsToast, true);
    assert.equal(modelRequests.filter(request => request.model === 'fixture-title-model').length, 3);
    assert.equal(await panel.locator('#session-name').textContent(), 'Second edit request');
    await panel.waitForSelector('#send-btn:not([disabled])');
    await panel.getByRole('button', { name: 'Dismiss notification' }).click();

    const reasoningScroll = await panel.evaluate(async () => {
      const chat = await import(chrome.runtime.getURL('src/sidepanel/chat.js'));
      const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
      stateModule.resetStream();
      const { messageEl, bodyEl } = chat.createStreamingMessage();
      Object.assign(stateModule.state.stream, { messageEl, bodyEl });
      stateModule.state.isStreaming = true;

      chat.appendReasoning(Array.from({ length: 120 }, (_, index) => `Thinking line ${index + 1}`).join('\n'));
      chat.flushPendingRender();
      const body = messageEl.querySelector('.reasoning-body');
      const distanceFromBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight;
      const initial = {
        overflowed: body.scrollHeight > body.clientHeight,
        atBottom: distanceFromBottom() <= 2
      };

      body.scrollTop = 0;
      body.dispatchEvent(new Event('scroll'));
      chat.appendReasoning('\nA new line while manually paused');
      chat.flushPendingRender();
      const paused = { scrollTop: body.scrollTop, atBottom: distanceFromBottom() <= 2 };

      body.scrollTop = body.scrollHeight;
      body.dispatchEvent(new Event('scroll'));
      chat.appendReasoning('\nA new line after returning to the bottom');
      chat.flushPendingRender();
      const resumed = { scrollTop: body.scrollTop, atBottom: distanceFromBottom() <= 2 };

      messageEl.remove();
      stateModule.resetStream();
      stateModule.state.isStreaming = false;
      return { initial, paused, resumed };
    });
    assert.equal(reasoningScroll.initial.overflowed, true);
    assert.equal(reasoningScroll.initial.atBottom, true);
    assert.equal(reasoningScroll.paused.scrollTop, 0);
    assert.equal(reasoningScroll.paused.atBottom, false);
    assert.ok(reasoningScroll.resumed.scrollTop > 0);
    assert.equal(reasoningScroll.resumed.atBottom, true);

    const security = await panel.evaluate(async () => {
      const chat = await import(chrome.runtime.getURL('src/sidepanel/chat.js'));
      const stateModule = await import(chrome.runtime.getURL('src/sidepanel/state.js'));
      chat.setupMarkdown();
      const host = document.createElement('div');
      document.body.appendChild(host);
      chat.renderMarkdownInto(host, [
        '<form><input autofocus onfocus="window.__bad=1"></form>',
        '<img src="https://remote.example/raw.png" onerror="window.__bad=2">',
        '[unsafe](javascript:alert(1))',
        '[cleartext](http://remote.example/plain)',
        '[safe](https://example.com/path)',
        '![remote alt](https://remote.example/markdown.png)'
      ].join('\n\n'));
      const safe = host.querySelector('a[href="https://example.com/path"]');
      const shape = {
        html: host.innerHTML,
        text: host.textContent,
        images: host.querySelectorAll('img').length,
        forms: host.querySelectorAll('form,input,script,iframe,object,embed').length,
        unsafeLinks: host.querySelectorAll('a[href^="javascript:"],a[href^="http:"]').length,
        safeRel: safe?.rel || '',
        safeTarget: safe?.target || '',
        bad: window.__bad || 0
      };
      stateModule.state.chatHistory = [{ role: 'assistant', content: '<img src="https://remote.example/import.png" onerror="window.__bad=3"> [bad](javascript:alert(2))' }];
      chat.renderMessages();
      shape.importedImages = document.querySelectorAll('#messages img').length;
      shape.importedUnsafeLinks = document.querySelectorAll('#messages a[href^="javascript:"]').length;
      const original = window.marked.parse;
      window.marked.parse = () => { throw new Error('fixture parser failure'); };
      chat.renderMarkdownInto(host, '<b>visible fallback</b>');
      shape.fallbackText = host.textContent;
      shape.fallbackElements = host.children.length;
      window.marked.parse = original;
      host.remove();
      return shape;
    });
    assert.equal(security.images, 0);
    assert.equal(security.forms, 0);
    assert.equal(security.unsafeLinks, 0);
    assert.match(security.safeRel, /noopener/);
    assert.match(security.safeRel, /noreferrer/);
    assert.equal(security.safeTarget, '_blank');
    assert.equal(security.bad, 0);
    assert.equal(security.importedImages, 0);
    assert.equal(security.importedUnsafeLinks, 0);
    assert.match(security.text, /Image: remote alt/);
    assert.equal(security.fallbackText, '<b>visible fallback</b>');
    assert.equal(security.fallbackElements, 0);
    assert.ok(!remoteRequests.some(url => url.startsWith('https://remote.example/')));
    assert.deepEqual(panelErrors, []);

    // Reproduce the MV3 recovery failure: persist an obsolete MAIN-world
    // registration, terminate the worker under an already-open Typst tab, and
    // require the fresh worker to repair both the registration and live bridge.
    const staleFiles = await worker.evaluate(async () => {
      const [registration] = await chrome.scripting.getRegisteredContentScripts({ ids: ['typst-side-agent-main'] });
      const js = registration.js.filter(path => path !== 'src/content/bridge-protocol.js');
      await chrome.scripting.updateContentScripts([{ id: registration.id, js }]);
      return js;
    });
    assert.ok(!staleFiles.includes('src/content/bridge-protocol.js'));

    const previousWorker = worker;
    const cdp = await context.newCDPSession(fixturePage);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workerTarget = targetInfos.find(target =>
      target.type === 'service_worker' && target.url === previousWorker.url()
    );
    assert.ok(workerTarget?.targetId, 'extension service-worker target was not discoverable');
    await cdp.send('Target.closeTarget', { targetId: workerTarget.targetId });
    await cdp.detach();

    // A real browser tab update is a registered extension event and therefore
    // wakes a stopped MV3 worker without reloading the original Typst tab.
    const wakePage = await context.newPage();
    await wakePage.goto('https://typst.app/project/browser-fixture');
    await wakePage.waitForSelector('.cm-content');

    // Playwright may retain the same Worker object across an MV3 restart and
    // emit no new serviceworker event, so usability—not object identity—is the
    // synchronization condition. Evaluating a live candidate wakes the worker.
    let usableWorker = null;
    for (let attempt = 0; attempt < 100 && !usableWorker; attempt++) {
      const candidates = [...new Set([previousWorker, ...context.serviceWorkers().slice().reverse()])];
      for (const candidate of candidates) {
        const runtimeId = await candidate.evaluate(() => chrome.runtime.id).catch(() => null);
        if (runtimeId === extensionId) {
          usableWorker = candidate;
          break;
        }
      }
      if (!usableWorker) await fixturePage.waitForTimeout(100);
    }
    assert.ok(usableWorker, 'no usable extension service worker after worker termination');
    worker = usableWorker;
    await wakePage.close();

    // A fresh panel performs a real runtime request after the worker is live,
    // covering the same wake/reconnect path users take after an extension reload.
    const recoveredPanel = await context.newPage();
    let panelLoaded = false;
    const panelLoadErrors = [];
    for (let attempt = 0; attempt < 20 && !panelLoaded; attempt++) {
      panelLoaded = await recoveredPanel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 2_000
      }).then(() => true, error => {
        panelLoadErrors.push(error?.message || String(error));
        return false;
      });
      if (!panelLoaded) await fixturePage.waitForTimeout(100);
    }
    assert.equal(panelLoaded, true, `extension panel did not wake after worker termination: ${panelLoadErrors.at(-1) || 'unknown error'}`);

    let repairedRegistration = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      repairedRegistration = await worker.evaluate(async () => {
        const [registration] = await chrome.scripting.getRegisteredContentScripts({ ids: ['typst-side-agent-main'] });
        return registration || null;
      }).catch(() => null);
      if (repairedRegistration?.js?.[0] === 'src/content/bridge-protocol.js') break;
      await fixturePage.waitForTimeout(100);
    }
    assert.equal(repairedRegistration?.js?.[0], 'src/content/bridge-protocol.js');

    await recoveredPanel.waitForSelector('#messages', { state: 'attached' });
    const recoveredContext = await recoveredPanel.evaluate(async tabIdValue => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.GET_EDITOR_CONTEXT, { tabId: tabIdValue }));
      return protocol.unwrapResponse(response);
    }, tabId);
    assert.equal(recoveredContext.fullText, '= Browser fixture');
  } finally {
    await context?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});

async function waitForSavedEditorApprovalMode(panel, expected) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const mode = await panel.evaluate(async () => {
      const protocol = await import(chrome.runtime.getURL('src/shared/protocol.js'));
      const response = await chrome.runtime.sendMessage(protocol.buildRequest(protocol.PROTOCOL.LOAD_SETTINGS));
      return protocol.unwrapResponse(response).editorApprovalMode;
    });
    if (mode === expected) return;
    await panel.waitForTimeout(50);
  }
  throw new Error(`Editor approval mode was not persisted as ${expected}`);
}

async function browserCandidates() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath()
  ].filter(Boolean);
  const out = [];
  for (const path of [...new Set(candidates)]) {
    try { await access(path, fsConstants.X_OK); out.push(path); } catch { /* unavailable */ }
  }
  if (!out.length) throw new Error('Pinned Chromium executable not found. Run: npx --no-install playwright-core install --with-deps chromium');
  return out;
}

async function extractStoreZip(buffer, destination) {
  const expected = new Set(listZipEntries(buffer));
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (method !== 0 || !expected.has(name)) throw new Error(`Unsupported or unexpected ZIP entry: ${name}`);
    const dataStart = nameStart + nameLength + extraLength;
    const target = resolve(destination, ...name.split('/'));
    if (!target.startsWith(resolve(destination))) throw new Error(`Unsafe extracted path: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  if (expected.size === 0) throw new Error('Archive contains no files.');
}
