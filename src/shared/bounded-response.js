import { raceWithSignal } from './abort.js';
import { codedError } from './errors.js';

/** Read a response body without allowing the network stream to exceed maxBytes. */
export async function readResponseTextBounded(response, options = {}) {
  const maxBytes = options.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive integer.');
  const errorCode = options.errorCode || 'RESPONSE_TOO_LARGE';
  const errorMessage = options.errorMessage || `Response exceeds the ${maxBytes}-byte limit.`;
  const declared = Number(response?.headers?.get?.('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw codedError(errorCode, errorMessage);

  if (!response?.body?.getReader) {
    const text = await raceWithSignal(response.text(), options.signal);
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw codedError(errorCode, errorMessage);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let reachedEof = false;
  try {
    while (true) {
      const { value, done } = await raceWithSignal(reader.read(), options.signal);
      if (done) {
        reachedEof = true;
        text += decoder.decode();
        break;
      }
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw codedError(errorCode, errorMessage);
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    if (!reachedEof) {
      try { await reader.cancel(); } catch { /* stream already closed */ }
    } else {
      try { reader.releaseLock?.(); } catch { /* no lock to release */ }
    }
  }
}
