import { PROTOCOL } from '../shared/protocol.js';

const RUN_UI_EVENTS = new Set([
  PROTOCOL.AI_STREAM_BATCH,
  PROTOCOL.AI_STREAM_DONE,
  PROTOCOL.AI_STREAM_CANCELLED,
  PROTOCOL.AI_STREAM_ERROR,
  PROTOCOL.AI_TOOL_CALLS,
  PROTOCOL.AI_TOOL_RESULT,
  PROTOCOL.AI_TOOL_PREFLIGHT_WAITING,
  PROTOCOL.AI_TOOL_PREFLIGHT_READY,
  PROTOCOL.AI_TOOL_APPROVAL_REQUIRED
]);

/** Owns immutable UI run identity, event acceptance, and terminal settlement. */
export function createRunUiController({ state }) {
  if (!state) throw new TypeError('Run UI controller requires state.');
  return Object.freeze({
    begin(identity) {
      if (state.activeRun) throw new Error('A side-panel run is already active.');
      let resolveTerminal;
      const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
      const run = Object.freeze({
        runId: identity.runId,
        tabId: identity.tabId,
        projectId: identity.projectId,
        sessionId: identity.sessionId,
        history: identity.history,
        reconnected: !!identity.reconnected,
        terminalPromise,
        resolveTerminal
      });
      state.activeRun = run;
      return run;
    },
    accepts(message) {
      return !RUN_UI_EVENTS.has(message?.type) || message.runId === state.activeRun?.runId;
    },
    complete(run = state.activeRun) {
      if (!run || state.activeRun !== run) return false;
      run.resolveTerminal();
      state.activeRun = null;
      return true;
    },
    current() {
      return state.activeRun;
    }
  });
}
