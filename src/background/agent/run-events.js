/** Run-scoped event emission to the side panel, mirrored into the transcript. */
import { buildRunEvent } from '../../shared/protocol.js';
import { adapters } from './agent-adapters.js';
import { recordTranscriptEvent } from './run-transcript.js';

export function emit(run, type, payload = {}, options = {}) {
  if (run.terminal && !options.terminal) return;
  recordTranscriptEvent(run, type, payload);
  adapters.runtimeSend(buildRunEvent(type, run.runId, payload));
}
