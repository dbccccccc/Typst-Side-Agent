/**
 * Queue for "Add to agent" events raised by the page's floating buttons.
 * Events are deduplicated by id, held until the panel is ready, delivered one
 * at a time, and merged with events the worker buffered while the panel was closed.
 */
import { PROTOCOL } from '../shared/protocol.js';

const QUICK_ATTACH_TYPES = new Set([PROTOCOL.QUICK_ATTACH_SELECTION, PROTOCOL.QUICK_ATTACH_IMAGE_PREVIEW]);
const MAX_SEEN_EVENT_IDS = 128;

export function createQuickAttachController({ state, request, deliver, setStatus }) {
  if (!state || typeof request !== 'function' || typeof deliver !== 'function') {
    throw new TypeError('Quick attach controller requires state, request, and deliver.');
  }
  let ready = false;
  let delivery = Promise.resolve();
  const queued = [];
  const seenEventIds = new Set();

  function rememberEvent(source) {
    const eventId = typeof source?.eventId === 'string' ? source.eventId : null;
    if (!eventId) return true;
    if (seenEventIds.has(eventId)) return false;
    seenEventIds.add(eventId);
    while (seenEventIds.size > MAX_SEEN_EVENT_IDS) seenEventIds.delete(seenEventIds.values().next().value);
    return true;
  }

  function schedule(type, source) {
    delivery = delivery
      .then(() => deliver(type, source))
      .catch(error => setStatus?.(error?.message || String(error), true));
    return delivery;
  }

  function enqueue(type, source) {
    if (!QUICK_ATTACH_TYPES.has(type) || !rememberEvent(source)) return false;
    if (!ready) {
      queued.push({ type, source });
      return true;
    }
    schedule(type, source);
    return true;
  }

  /** Mark the panel ready, flush local events, then pull events buffered by the worker. */
  async function drain() {
    ready = true;
    const local = queued.splice(0);
    for (const item of local) schedule(item.type, item.source);
    if (!Number.isInteger(state.activeWindowId)) return local.length;
    const remote = await request({ type: PROTOCOL.QUICK_ATTACH_DRAIN, windowId: state.activeWindowId });
    let accepted = local.length;
    for (const record of Array.isArray(remote) ? remote : []) {
      if (enqueue(record?.type, record?.payload)) accepted += 1;
    }
    return accepted;
  }

  return Object.freeze({
    enqueue,
    drain,
    isReady: () => ready,
    pendingCount: () => queued.length,
    /** Resolves after every delivery scheduled so far has settled. */
    settled: () => delivery
  });
}
