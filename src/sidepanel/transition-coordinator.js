/** Coordinates side-panel async transitions without owning DOM or Chrome APIs. */
export function createTransitionCoordinator() {
  let activeSend = null;
  let tabEpoch = 0;
  let sessionEpoch = 0;

  return Object.freeze({
    beginSend(identity) {
      if (activeSend) return null;
      activeSend = Object.freeze({ ...identity });
      return activeSend;
    },
    isSendCurrent(token, identity) {
      return activeSend === token
        && token?.projectId === identity?.projectId
        && token?.sessionId === identity?.sessionId
        && token?.history === identity?.history;
    },
    endSend(token) {
      if (activeSend !== token) return false;
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
