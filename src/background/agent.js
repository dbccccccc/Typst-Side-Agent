/**
 * Agent facade. The run machinery lives under ./agent/ (adapters, registry,
 * preflight waits, tool runners, transcript, run loop); the service worker and
 * tests import this stable surface.
 */
export { configureAgentAdapters } from './agent/agent-adapters.js';
export { getActiveRunIds, getActiveRunSummaries, resetAgentAdapters } from './agent/run-registry.js';
export { resolveApproval, resolvePreflight } from './agent/tool-preflight.js';
export { abortRun, handleStreamStart, reserveRun, sortToolCallsForExecution } from './agent/run-loop.js';
export { generateSessionTitle, sanitizeTitle } from './agent/session-title.js';
export { extractReasoningChunk, splitInlineThink } from './provider.js';
