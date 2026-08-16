export function quickAttachSource(sender) {
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(windowId) || windowId < 0) return null;
  return { tabId, windowId };
}

export function isQuickAttachForPanel(state, payload) {
  return Number.isInteger(payload?.tabId) && Number.isInteger(payload?.windowId) &&
    payload.tabId === state?.activeTabId && payload.windowId === state?.activeWindowId;
}
