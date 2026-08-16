import { SEND_MESSAGE_SHORTCUTS, normalizeSendMessageShortcut } from '../shared/constants.js';

const SHORTCUT_LABELS = Object.freeze({
  [SEND_MESSAGE_SHORTCUTS.ENTER]: 'Enter',
  [SEND_MESSAGE_SHORTCUTS.SHIFT_ENTER]: 'Shift + Enter',
  [SEND_MESSAGE_SHORTCUTS.CTRL_ENTER]: 'Ctrl + Enter'
});

export function sendMessageShortcutLabel(value) {
  return SHORTCUT_LABELS[normalizeSendMessageShortcut(value)];
}

/** Match only the configured Enter chord; every other chord keeps textarea newline behavior. */
export function shouldSendMessageForKey(event, configuredShortcut) {
  if (!event || event.key !== 'Enter' || event.isComposing || event.altKey || event.metaKey) return false;
  const shift = Boolean(event.shiftKey);
  const ctrl = Boolean(event.ctrlKey);
  if (shift && ctrl) return false;

  switch (normalizeSendMessageShortcut(configuredShortcut)) {
    case SEND_MESSAGE_SHORTCUTS.SHIFT_ENTER:
      return shift && !ctrl;
    case SEND_MESSAGE_SHORTCUTS.CTRL_ENTER:
      return ctrl && !shift;
    default:
      return !shift && !ctrl;
  }
}
