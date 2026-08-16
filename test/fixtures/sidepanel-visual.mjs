/* global document, location, DOMParser */

import { state } from '../../src/sidepanel/state.js';
import { renderMessages, setSendButtonStop, setupMarkdown } from '../../src/sidepanel/chat.js';
import { errorResponse } from '../../src/shared/protocol.js';
import { createStatusController } from '../../src/sidepanel/status-controller.js';

setupMarkdown();
setSendButtonStop(false);

const fixtureInput = document.getElementById('user-input');
fixtureInput?.addEventListener('input', () => {
  fixtureInput.style.height = 'auto';
  fixtureInput.style.height = `${Math.min(fixtureInput.scrollHeight, 130)}px`;
});

const fixtureParams = new URLSearchParams(location.search);
const fixtureState = fixtureParams.get('state');
document.documentElement.dataset.theme = fixtureParams.get('theme') === 'light' ? 'light' : 'dark';

if (fixtureState === 'about' || fixtureParams.get('settings') === 'open') {
  const [sidepanelMarkup, fixtureManifest] = await Promise.all([
    fetch('../../src/sidepanel/index.html').then(response => response.text()),
    fetch('../../manifest.json').then(response => response.json())
  ]);
  const sidepanelDocument = new DOMParser().parseFromString(sidepanelMarkup, 'text/html');
  const versionLabel = `Version ${fixtureManifest.version}`;
  const aboutSettingsSection = sidepanelDocument.getElementById('about-settings-button')?.closest('.settings-section');
  if (aboutSettingsSection) {
    document.querySelector('.settings-tab-pane.active')?.append(aboutSettingsSection);
    document.getElementById('about-settings-version').textContent = versionLabel;
  }
  if (fixtureState === 'about') {
    const aboutDialog = sidepanelDocument.getElementById('about-dialog-layer');
    if (aboutDialog) {
      aboutDialog.classList.remove('hidden');
      document.querySelector('.app')?.append(aboutDialog);
      document.getElementById('about-dialog-version').textContent = versionLabel;
    }
  }
}

const fixtureSendShortcut = ['shift-enter', 'ctrl-enter'].includes(fixtureParams.get('sendShortcut'))
  ? fixtureParams.get('sendShortcut')
  : 'enter';
const fixtureSendShortcutLabels = {
  enter: 'Enter',
  'shift-enter': 'Shift + Enter',
  'ctrl-enter': 'Ctrl + Enter'
};
const fixtureSendSelect = document.getElementById('send-message-shortcut');
if (fixtureSendSelect) fixtureSendSelect.value = fixtureSendShortcut;
const fixtureSendHint = document.getElementById('send-shortcut-hint');
if (fixtureSendHint) fixtureSendHint.textContent = fixtureSendShortcutLabels[fixtureSendShortcut];
if (fixtureParams.get('settings') === 'open') {
  document.getElementById('settings-panel')?.classList.remove('collapsed');
}
const fixtureEditorMode = fixtureParams.get('editorMode') === 'auto' ? 'auto' : 'ask';
const fixtureEditorButton = document.getElementById('editor-permission-btn');
const fixtureEditorCurrent = document.getElementById('editor-permission-current');
fixtureEditorButton.dataset.mode = fixtureEditorMode;
fixtureEditorButton.setAttribute('aria-label', `Document edits: ${fixtureEditorMode === 'auto' ? 'auto approve' : 'ask before applying'}`);
fixtureEditorCurrent.textContent = fixtureEditorMode === 'auto' ? 'Auto' : 'Ask';
document.querySelectorAll('[data-editor-approval-mode]').forEach(option => {
  const active = option.dataset.editorApprovalMode === fixtureEditorMode;
  option.classList.toggle('active', active);
  option.setAttribute('aria-checked', String(active));
});
if (fixtureParams.get('edits') === 'open') {
  fixtureEditorButton.setAttribute('aria-expanded', 'true');
  document.getElementById('editor-permission-menu')?.classList.remove('hidden');
}

if (fixtureState === 'chat') {
  state.chatHistory = [
    {
      role: 'user',
      content: 'Can you fix the spacing around the Results section and keep the existing style?'
    },
    {
      role: 'assistant',
      segments: [
        {
          type: 'reasoning',
          content: 'I checked the heading and paragraph settings, then compared the local spacing around the Results section.'
        },
        {
          type: 'tools',
          calls: [{ id: 'fixture-read', name: 'read_document', args: { start_line: 36, end_line: 74 } }],
          results: { 'fixture-read': { ok: true, doc_chars: 1284 } }
        },
        {
          type: 'text',
          content: 'The extra gap comes from a local `#v(1.5em)` immediately before the heading. I would remove that spacer and let the document’s heading rule control the rhythm.\n\nThe proposed edit keeps the rest of the section unchanged.'
        }
      ]
    },
    {
      role: 'user',
      content: 'Yes, show me the proposed change first.'
    }
  ];
} else if (fixtureState?.startsWith('revert-')) {
  const requestedState = fixtureState.slice('revert-'.length);
  const checkpointStatus = ['success', 'unavailable'].includes(requestedState)
    ? (requestedState === 'success' ? 'reverted' : 'unavailable')
    : 'applied';
  const checkpoint = {
    id: `visual-revert-${requestedState}`,
    status: checkpointStatus,
    fileLabel: 'Current Typst document',
    createdAt: 1,
    ...(checkpointStatus === 'unavailable'
      ? { unavailableReason: 'Revert data is not included in imported session files.' }
      : {})
  };
  state.activeTabOnTypst = true;
  state.activeTabId = 17;
  state.currentProjectId = 'visual-project';
  state.currentSession = { id: 'visual-session', projectId: 'visual-project' };
  state.chatHistory = [{
    role: 'assistant',
    responseStatus: 'complete',
    segments: [
      {
        type: 'tools',
        calls: [{ id: 'visual-edit', name: 'search_replace', args: { search: '#v(1.5em)', replace: '' } }],
        results: { 'visual-edit': { ok: true, editCheckpoint: checkpoint } }
      },
      {
        type: 'text',
        content: 'I removed the extra spacer and kept the document’s existing heading rhythm.'
      }
    ]
  }];

  if (requestedState === 'busy') {
    globalThis.chrome = { runtime: { sendMessage: () => new Promise(() => {}) } };
  } else if (requestedState === 'error') {
    globalThis.chrome = {
      runtime: {
        sendMessage: async request => errorResponse(request.requestId, {
          code: 'EDIT_CHECKPOINT_STALE',
          message: 'The document changed outside this chat, so the remaining edits could not be reverted.'
        })
      }
    };
  }
}

renderMessages();

if (fixtureState === 'revert-busy' || fixtureState === 'revert-error') {
  document.querySelector('.edit-revert-button')?.click();
  document.getElementById('revert-dialog-confirm')?.click();
  await new Promise(resolve => { setTimeout(resolve, 0); });
}

const fixtureToast = fixtureParams.get('toast');
if (fixtureToast === 'info' || fixtureToast === 'error') {
  createStatusController().set(
    fixtureToast === 'error'
      ? 'The document changed before this action completed. Copy this message if you need to share the details.'
      : 'Selection added to the current prompt.',
    fixtureToast === 'error',
    60_000
  );
}

document.documentElement.dataset.fixtureReady = 'true';
