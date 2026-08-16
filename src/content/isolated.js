(function () {
  'use strict';
  const bridge = globalThis.__typstAgentBridgeProtocol;
  if (!bridge) return;
  if (globalThis.__typstAgentIsolatedLoaded) return;
  globalThis.__typstAgentIsolatedLoaded = true;
  const { TYPES } = bridge;
  const nonce = crypto.randomUUID();
  const pending = new Map();
  const MAX_PENDING = 64;
  const TIMEOUT_MS = 12000;
  const MAIN_RECOVERY_DELAY_MS = 200;
  const MAIN_WORLD_FILES = Object.freeze([
    'src/content/bridge-protocol.js',
    'src/content/workspace.js',
    'src/content/diagnostics.js',
    'src/content/float-controller.js',
    'src/content/main.js'
  ]);
  let ready = false;
  let handshakeTimer = null;
  let recoveryTimer = null;
  let recoveryStarted = false;
  let recoveryAttempts = 0;
  let unloading = false;
  const cancelledRequests = new Map();

  function loadMainWorldFile(file) {
    return new Promise((resolve, reject) => {
      const parent = document.head || document.documentElement;
      if (!parent) {
        reject(new Error('The Typst document root is not ready.'));
        return;
      }
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(file);
      script.async = false;
      script.dataset.typstSideAgentMainRecovery = file;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`Could not load ${file} in the Typst page.`));
      };
      parent.appendChild(script);
    });
  }

  async function recoverMainWorld() {
    if (ready || recoveryStarted) return;
    recoveryStarted = true;
    try {
      for (const file of MAIN_WORLD_FILES) {
        if (ready) return;
        await loadMainWorldFile(file);
      }
    } finally {
      recoveryStarted = false;
    }
  }

  function scheduleMainWorldRecovery(delay = MAIN_RECOVERY_DELAY_MS) {
    if (ready || unloading || recoveryTimer != null) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      recoverMainWorld().catch(error => {
        console.warn('Typst Side Agent MAIN-world recovery failed:', error?.message || String(error));
        recoveryAttempts += 1;
        scheduleMainWorldRecovery(Math.min(5_000, MAIN_RECOVERY_DELAY_MS * (2 ** Math.min(recoveryAttempts, 5))));
      });
    }, delay);
  }

  function postHandshake() {
    if (ready) return;
    window.postMessage(bridge.envelope(TYPES.PAGE_BRIDGE_INIT, {}, {
      requestId: bridge.requestId('bridge'), nonce
    }), '*');
    handshakeTimer = setTimeout(postHandshake, 50);
  }

  function respondError(sendResponse, request, code, message) {
    sendResponse(bridge.envelope(TYPES.RESPONSE, { ok: false, error: { code, message } }, {
      requestId: request.requestId,
      runId: request.runId,
      nonce
    }));
  }

  function rememberCancelledRequest(requestId) {
    const previous = cancelledRequests.get(requestId);
    if (previous != null) clearTimeout(previous);
    const timer = setTimeout(() => cancelledRequests.delete(requestId), TIMEOUT_MS);
    cancelledRequests.set(requestId, timer);
  }

  function cancelPendingRequest(targetRequestId) {
    rememberCancelledRequest(targetRequestId);
    const item = pending.get(targetRequestId);
    if (!item) return false;
    pending.delete(targetRequestId);
    clearTimeout(item.timeout);
    respondError(item.sendResponse, item.request, 'CANCELLED', 'Page request was cancelled before completion.');
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!bridge.valid(message) || !bridge.PAGE_REQUESTS.has(message.type)) return false;
    if (typeof message.requestId !== 'string' || !message.requestId) {
      respondError(sendResponse, { ...message, requestId: bridge.requestId('invalid') }, 'INVALID_REQUEST_ID', 'Page request requires requestId.');
      return false;
    }
    if (message.type === TYPES.PAGE_CANCEL_REQUEST) {
      const targetRequestId = message.payload.targetRequestId;
      const cancelled = cancelPendingRequest(targetRequestId);
      if (ready) {
        window.postMessage(bridge.envelope(TYPES.PAGE_CANCEL_REQUEST, { targetRequestId }, {
          requestId: message.requestId,
          runId: message.runId,
          nonce
        }), '*');
      }
      sendResponse(bridge.envelope(TYPES.RESPONSE, { ok: true, data: { cancelled } }, {
        requestId: message.requestId,
        runId: message.runId,
        nonce
      }));
      return false;
    }
    if (cancelledRequests.has(message.requestId)) {
      clearTimeout(cancelledRequests.get(message.requestId));
      cancelledRequests.delete(message.requestId);
      respondError(sendResponse, message, 'CANCELLED', 'Page request was cancelled before dispatch.');
      return false;
    }
    if (pending.size >= MAX_PENDING) {
      respondError(sendResponse, message, 'PAGE_PENDING_LIMIT', 'Too many simultaneous page requests.');
      return false;
    }
    if (pending.has(message.requestId)) {
      respondError(sendResponse, message, 'DUPLICATE_REQUEST_ID', 'Duplicate page request id.');
      return false;
    }

    const timeout = setTimeout(() => {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      respondError(item.sendResponse, message, 'PAGE_REQUEST_TIMEOUT', `${message.type} (${message.requestId}) timed out.`);
    }, TIMEOUT_MS);
    const send = () => window.postMessage(bridge.envelope(message.type, message.payload, {
      requestId: message.requestId,
      runId: message.runId,
      nonce
    }), '*');
    pending.set(message.requestId, { sendResponse, timeout, expected: TYPES.RESPONSE, requestType: message.type, request: message, send, sent: false });
    if (ready) {
      pending.get(message.requestId).sent = true;
      send();
    }
    return true;
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || !bridge.valid(message) || message.nonce !== nonce) return;
    if (message.type === TYPES.PAGE_BRIDGE_READY) {
      ready = true;
      recoveryAttempts = 0;
      if (handshakeTimer != null) clearTimeout(handshakeTimer);
      if (recoveryTimer != null) clearTimeout(recoveryTimer);
      for (const item of pending.values()) {
        if (item.sent) continue;
        item.sent = true;
        item.send();
      }
      return;
    }
    if (message.type === TYPES.RESPONSE) {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      clearTimeout(item.timeout);
      if (!bridge.validResponse(message, item.requestType)) {
        respondError(item.sendResponse, item.request, 'INVALID_PAGE_RESPONSE', `${item.requestType} returned an invalid or oversized response.`);
      } else {
        item.sendResponse(message);
      }
      return;
    }
    if (message.type === TYPES.PAGE_QUICK_SELECTION || message.type === TYPES.PAGE_QUICK_IMAGE_PREVIEW) {
      const type = message.type === TYPES.PAGE_QUICK_SELECTION
        ? TYPES.QUICK_ATTACH_SELECTION
        : TYPES.QUICK_ATTACH_IMAGE_PREVIEW;
      chrome.runtime.sendMessage(bridge.envelope(type, {}, { requestId: bridge.requestId('quick') })).catch(() => {});
    }
  });

  window.addEventListener('pagehide', () => {
    unloading = true;
    if (handshakeTimer != null) clearTimeout(handshakeTimer);
    if (recoveryTimer != null) clearTimeout(recoveryTimer);
    for (const [requestId, item] of pending) {
      clearTimeout(item.timeout);
      respondError(item.sendResponse, { requestId }, 'PAGE_UNLOADED', 'Page unloaded before responding.');
    }
    pending.clear();
    for (const timer of cancelledRequests.values()) clearTimeout(timer);
    cancelledRequests.clear();
  }, { once: true });

  scheduleMainWorldRecovery();
  postHandshake();
})();
