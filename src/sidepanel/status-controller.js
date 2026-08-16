const DEFAULT_INFO_DURATION_MS = 4_000;
const DEFAULT_ERROR_DURATION_MS = 7_000;
const COLLAPSE_DURATION_MS = 180;
const COPY_FEEDBACK_DURATION_MS = 1_200;

async function copyToClipboard(text, documentRef) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  if (!documentRef?.createElement || !documentRef?.body?.appendChild || !documentRef?.execCommand) {
    throw new Error('Clipboard access is unavailable.');
  }
  const input = documentRef.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  documentRef.body.appendChild(input);
  input.select();
  const copied = documentRef.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy failed.');
}

export function createStatusController({
  documentRef = globalThis.document,
  setTimer = (...args) => setTimeout(...args),
  clearTimer = id => clearTimeout(id),
  copyText = text => copyToClipboard(text, documentRef),
  defaultInfoDurationMs = DEFAULT_INFO_DURATION_MS,
  defaultErrorDurationMs = DEFAULT_ERROR_DURATION_MS,
  collapseDurationMs = COLLAPSE_DURATION_MS
} = {}) {
  let generation = 0;
  let expiryTimer = null;
  let collapseTimer = null;
  let copyFeedbackTimer = null;
  let currentText = '';
  let wiredElement = null;

  const get = id => documentRef?.getElementById?.(id) || null;

  function clearScheduled() {
    if (expiryTimer != null) clearTimer(expiryTimer);
    if (collapseTimer != null) clearTimer(collapseTimer);
    expiryTimer = null;
    collapseTimer = null;
  }

  function resetCopyFeedback() {
    if (copyFeedbackTimer != null) clearTimer(copyFeedbackTimer);
    copyFeedbackTimer = null;
    const button = get('status-copy');
    button?.classList?.remove?.('is-copied', 'is-copy-error');
    if (button) {
      button.title = 'Copy message';
      button.setAttribute?.('aria-label', 'Copy notification message');
    }
  }

  function finishCollapse(element, expectedGeneration) {
    if (generation !== expectedGeneration) return;
    element.classList?.remove?.('is-visible', 'is-leaving', 'has-expiry');
    element.classList?.add?.('hidden');
    element.setAttribute?.('aria-hidden', 'true');
  }

  function collapse(expectedGeneration = generation, immediate = false) {
    const element = get('status');
    if (!element || generation !== expectedGeneration) return;
    element.classList?.remove?.('is-visible', 'has-expiry');
    element.classList?.add?.('is-leaving');
    element.setAttribute?.('aria-hidden', 'true');
    if (immediate || collapseDurationMs <= 0) {
      finishCollapse(element, expectedGeneration);
      return;
    }
    collapseTimer = setTimer(() => {
      collapseTimer = null;
      finishCollapse(element, expectedGeneration);
    }, collapseDurationMs);
  }

  async function copy() {
    const button = get('status-copy');
    if (!currentText) return false;
    resetCopyFeedback();
    try {
      await copyText(currentText);
      button?.classList?.add?.('is-copied');
      if (button) {
        button.title = 'Copied';
        button.setAttribute?.('aria-label', 'Notification copied');
      }
      copyFeedbackTimer = setTimer(resetCopyFeedback, COPY_FEEDBACK_DURATION_MS);
      return true;
    } catch {
      button?.classList?.add?.('is-copy-error');
      if (button) {
        button.title = 'Could not copy';
        button.setAttribute?.('aria-label', 'Could not copy notification');
      }
      copyFeedbackTimer = setTimer(resetCopyFeedback, COPY_FEEDBACK_DURATION_MS);
      return false;
    }
  }

  function dismiss() {
    generation += 1;
    clearScheduled();
    resetCopyFeedback();
    currentText = '';
    const message = get('status-message');
    if (message) message.textContent = '';
    collapse(generation);
    return generation;
  }

  function wire(element) {
    if (!element || wiredElement === element) return;
    wiredElement = element;
    get('status-copy')?.addEventListener?.('click', () => { void copy(); });
    get('status-close')?.addEventListener?.('click', dismiss);
  }

  function set(text = '', isError = false, durationMs) {
    generation += 1;
    const currentGeneration = generation;
    clearScheduled();
    resetCopyFeedback();

    const element = get('status');
    currentText = String(text || '');
    if (!element) return currentGeneration;
    wire(element);

    const message = get('status-message') || element;
    message.textContent = currentText;
    element.classList?.toggle?.('error', !!isError);
    element.classList?.toggle?.('is-error', !!isError);
    element.setAttribute?.('role', isError ? 'alert' : 'status');

    if (!currentText) {
      collapse(currentGeneration);
      return currentGeneration;
    }

    element.classList?.remove?.('hidden', 'is-leaving', 'has-expiry');
    // Force a style boundary so replacing a toast restarts its entrance and timer animations.
    if (typeof element.offsetWidth === 'number') void element.offsetWidth;
    element.classList?.add?.('is-visible');
    element.setAttribute?.('aria-hidden', 'false');

    const effectiveDuration = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : (isError ? defaultErrorDurationMs : defaultInfoDurationMs);
    element.style?.setProperty?.('--status-duration', `${effectiveDuration}ms`);
    if (effectiveDuration > 0) {
      element.classList?.add?.('has-expiry');
      expiryTimer = setTimer(() => {
        if (generation !== currentGeneration) return;
        expiryTimer = null;
        collapse(currentGeneration);
      }, effectiveDuration);
    }
    return currentGeneration;
  }

  function reset() {
    generation += 1;
    clearScheduled();
    resetCopyFeedback();
    currentText = '';
    collapse(generation, true);
  }

  return Object.freeze({ set, reset, dismiss, copy });
}

const sharedStatusController = createStatusController();

/** Own the shared status toast so an older expiry cannot erase a newer message. */
export const setStatus = (...args) => sharedStatusController.set(...args);
export const resetStatusController = () => sharedStatusController.reset();
