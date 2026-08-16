/** Coordinates side-panel async transitions without owning DOM or Chrome APIs. */
export function createTransitionCoordinator() {
  let activeSend = null;
  let tabEpoch = 0;
  let sessionEpoch = 0;

  return Object.freeze({
    beginSend(identity) {
      if (activeSend) return null;
      const token = Object.freeze({ ...identity });
      activeSend = { token, phase: 'preparing', runId: null, cancelled: false };
      return token;
    },
    isSendCurrent(token, identity) {
      return activeSend?.token === token
        && !activeSend.cancelled
        && token?.projectId === identity?.projectId
        && token?.sessionId === identity?.sessionId
        && token?.history === identity?.history;
    },
    markReserved(token, runId) {
      if (activeSend?.token !== token || activeSend.cancelled || activeSend.phase !== 'preparing') return false;
      activeSend.runId = runId;
      activeSend.phase = 'reserved';
      return true;
    },
    markStarting(token) {
      if (activeSend?.token !== token || activeSend.cancelled || activeSend.phase !== 'reserved') return false;
      activeSend.phase = 'starting';
      return true;
    },
    canDispatch(token) {
      return activeSend?.token === token && !activeSend.cancelled && activeSend.phase === 'reserved';
    },
    cancelRun(runId) {
      if (!activeSend || activeSend.runId !== runId) return false;
      activeSend.cancelled = true;
      activeSend.phase = 'cancelled';
      return true;
    },
    cancelSend(token) {
      if (activeSend?.token !== token) return false;
      activeSend.cancelled = true;
      activeSend.phase = 'cancelled';
      return true;
    },
    endSend(token) {
      if (activeSend?.token !== token) return false;
      activeSend = null;
      return true;
    },
    hasActiveSend() {
      return activeSend != null;
    },
    nextTabSync() {
      tabEpoch += 1;
      return tabEpoch;
    },
    isTabSyncCurrent(epoch) {
      return epoch === tabEpoch;
    },
    nextSessionSwitch() {
      sessionEpoch += 1;
      return sessionEpoch;
    },
    isSessionSwitchCurrent(epoch) {
      return epoch === sessionEpoch;
    }
  });
}
