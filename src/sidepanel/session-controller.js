import { PROTOCOL } from '../shared/protocol.js';

/** Owns session persistence commands and the active session/history transition. */
export function createSessionController({ request, state = null }) {
  if (typeof request !== 'function') throw new TypeError('Session controller requires a request function.');

  return Object.freeze({
    list: projectId => request({ type: PROTOCOL.SESSION_LIST, projectId }),
    create: (projectId, name = 'New chat') => request({ type: PROTOCOL.SESSION_CREATE, projectId, name }),
    get: sessionId => request({ type: PROTOCOL.SESSION_GET, sessionId }),
    update: (sessionId, updates = {}) => request({ type: PROTOCOL.SESSION_UPDATE, sessionId, ...updates }),
    updateAutoName: (sessionId, name) => request({ type: PROTOCOL.SESSION_UPDATE, sessionId, name, autoName: true }),
    saveSnapshot: (sessionId, messages) => request({ type: PROTOCOL.SESSION_UPDATE, sessionId, messages }),
    remove: sessionId => request({ type: PROTOCOL.SESSION_DELETE, sessionId }),
    listGrouped: () => request({ type: PROTOCOL.SESSION_LIST_ALL_GROUPED }),
    removeProject: projectId => request({ type: PROTOCOL.SESSION_DELETE_BY_PROJECT, projectId }),
    storageStatus: () => request({ type: PROTOCOL.SESSION_STORAGE_STATUS }),
    openProject: projectId => request({ type: PROTOCOL.OPEN_PROJECT_TAB, projectId }),
    exportAll: () => request({ type: PROTOCOL.SESSION_EXPORT }),
    importAll: exportData => request({ type: PROTOCOL.SESSION_IMPORT, exportData }),
    activate(session) {
      if (!state) throw new Error('This session controller has no active-state owner.');
      state.currentSession = session || null;
      state.chatHistory = Array.isArray(session?.messages) ? [...session.messages] : [];
      return state.chatHistory;
    }
  });
}
