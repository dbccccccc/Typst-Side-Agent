/** Global side-panel state. Mutated in place; modules read directly. */

export const state = {
  activeTabOnTypst: false,
  currentProjectId: null,
  currentSession: null,
  chatHistory: [],
  isStreaming: false,

  settings: {
    systemPrompt: '',
    models: [],
    activeModelId: null,
    maxHistoryMessages: 40,
    autoNameModelId: null
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
    currentText: '',
    allText: '',
    currentReasoningEl: null,
    currentReasoningText: '',
    allReasoning: '',
    toolCalls: [],
    segments: []
  }
};

export function resetAttachments() {
  state.attachments = {
    selections: [],
    previews: []
  };
}

export function resetStream() {
  state.stream = {
    messageEl: null,
    bodyEl: null,
    currentContentEl: null,
    currentText: '',
    allText: '',
    currentReasoningEl: null,
    currentReasoningText: '',
    allReasoning: '',
    toolCalls: [],
    segments: []
  };
}

export function getActiveModel() {
  if (!state.settings.models.length) return null;
  return state.settings.models.find(m => m.id === state.settings.activeModelId) || state.settings.models[0];
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export const bg = (msg) => chrome.runtime.sendMessage(msg);
