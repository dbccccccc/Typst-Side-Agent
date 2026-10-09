/** Active run records plus the bounded reservation/admission coordinator. */
import { createRunCoordinator } from '../run-coordinator.js';
import { adapters, configureAgentAdapters } from './agent-adapters.js';

export const runs = new Map();
export const runCoordinator = createRunCoordinator({ now: () => adapters.now() });

export function runIdentity(message) {
  return {
    runId: message.runId,
    tabId: message.payload.tabId,
    projectId: message.payload.projectId,
    sessionId: message.payload.sessionId
  };
}

export function getActiveRunIds() {
  return [...runs.keys()];
}

export function getActiveRunSummaries() {
  return [...runs.values()].map(run => ({
    runId: run.runId,
    tabId: run.tabId,
    projectId: run.projectId,
    sessionId: run.sessionId,
    startedAt: run.startedAt
  }));
}

/** Restore default adapters and forget every reservation; used between tests. */
export function resetAgentAdapters() {
  configureAgentAdapters();
  runCoordinator.reset();
}
