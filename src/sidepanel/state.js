/** Global side-panel state. Mutated in place; modules read directly. */
import { buildRequest, unwrapResponse } from '../shared/protocol.js';

export const state = {
  activeTabOnTypst: false,
  activeTabId: null,
  activeWindowId: null,
  currentProjectId: null,
  currentSession: null,
  chatHistory: [],
  isStreaming: false,
  activeRun: null,

  settings: {
    systemPrompt: '',
    models: [],
    activeModelId: null,
    maxHistoryMessages: 40,
    autoNameModelId: null,
    editorApprovalMode: 'ask',
    sendMessageShortcut: 'enter'
  },

  customTools: [],
  mcpServers: [],

  attachments: {
    selections: [],
    previews: []
  },

  stream: {
    messageEl: null,
    bodyEl: null,
    currentContentEl: null,
    currentContentTextNode: null,
    currentText: '',
    renderedContentChars: 0,
    allText: '',
    currentReasoningEl: null,
    currentReasoningText: '',
    allReasoning: '',
    toolCalls: [],
    segments: [],
    renderFrame: null,
    dirtyContent: false,
    dirtyReasoning: false,
    followBeforeRender: null
  }
};

export function resetStream() {
  state.stream = {
    messageEl: null,
    bodyEl: null,
    currentContentEl: null,
    currentContentTextNode: null,
    currentText: '',
    renderedContentChars: 0,
    allText: '',
    currentReasoningEl: null,
    currentReasoningText: '',
    allReasoning: '',
    toolCalls: [],
    segments: [],
    renderFrame: null,
    dirtyContent: false,
    dirtyReasoning: false,
    followBeforeRender: null
  };
}

export function getActiveModel() {
  if (!state.settings.models.length) return null;
  return state.settings.models.find(m => m.id === state.settings.activeModelId) || state.settings.models[0];
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function bg(message) {
  const { type, runId, ...payload } = message || {};
  const response = await chrome.runtime.sendMessage(buildRequest(type, payload, { runId }));
  return unwrapResponse(response);
}
