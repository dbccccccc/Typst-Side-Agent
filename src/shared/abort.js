/** Compose a parent AbortSignal with a timeout while preserving the reason. */
export function createOperationSignal(parentSignal, timeoutMs, options = {}) {
  const controller = new AbortController();
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  let code = null;

  const abort = (nextCode, reason) => {
    if (controller.signal.aborted) return;
    code = nextCode;
    controller.abort(reason || new DOMException(nextCode, 'AbortError'));
  };
  const onParentAbort = () => abort('CANCELLED', parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimer(() => abort('TIMEOUT', new DOMException('Operation timed out', 'TimeoutError')), timeoutMs)
    : null;

  return {
    signal: controller.signal,
    get code() { return code; },
    cleanup() {
      if (timer != null) clearTimer(timer);
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    }
  };
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled');
  error.code = 'CANCELLED';
  error.cause = signal.reason;
  throw error;
}

export function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

export function isAbortError(error) {
  return error?.code === 'CANCELLED' || error?.name === 'AbortError';
}

function cancelledError(cause) {
  const error = new Error('Operation cancelled');
  error.code = 'CANCELLED';
  error.cause = cause;
  return error;
}
