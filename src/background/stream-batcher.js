/** Order-preserving, cadence-bounded coalescer for streamed text channels. */
export function createStreamBatcher({ runId, emit, delayMs = 32, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let queue = [];
  let timer = null;
  let closed = false;

  function push(channel, text) {
    if (closed || !text) return;
    const last = queue[queue.length - 1];
    if (last?.channel === channel) last.text += text;
    else queue.push({ channel, text });
    if (timer == null) timer = setTimer(flush, delayMs);
  }

  function flush() {
    if (timer != null) clearTimer(timer);
    timer = null;
    if (!queue.length || closed) return;
    const items = queue;
    queue = [];
    emit({ runId, items });
  }

  function cancel({ flushPending = false } = {}) {
    if (flushPending) flush();
    if (timer != null) clearTimer(timer);
    timer = null;
    queue = [];
    closed = true;
  }

  return { push, flush, cancel, get pendingCount() { return queue.length; } };
}
