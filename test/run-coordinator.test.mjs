import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunCoordinator } from '../src/background/run-coordinator.js';

const identity = (runId, sessionId = 'session-a', projectId = 'project-a') => ({
  runId, tabId: 7, projectId, sessionId
});

test('run coordinator admits one owner per project session without blocking unrelated sessions', () => {
  const coordinator = createRunCoordinator();
  assert.equal(coordinator.reserve(identity('run-a')).ok, true);
  assert.equal(coordinator.reserve(identity('run-b')).code, 'SESSION_RUN_ACTIVE');
  assert.equal(coordinator.reserve(identity('run-c', 'session-b')).ok, true);
  assert.equal(coordinator.reserve(identity('run-d', 'session-a', 'project-b')).ok, true);
  assert.equal(coordinator.admit(identity('run-a')).ok, true);
  assert.equal(coordinator.reserve(identity('run-e')).code, 'SESSION_RUN_ACTIVE');
  assert.equal(coordinator.complete('run-a'), true);
  assert.equal(coordinator.reserve(identity('run-e')).ok, true);
});

test('run coordinator expires abandoned reservations and bounds cancellation tombstones', () => {
  let clock = 100;
  const coordinator = createRunCoordinator({
    now: () => clock,
    reservationTtlMs: 10,
    tombstoneTtlMs: 20,
    maxReservations: 1,
    maxTombstones: 2
  });
  assert.equal(coordinator.reserve(identity('run-a')).ok, true);
  assert.equal(coordinator.reserve(identity('run-b', 'session-b')).code, 'RUN_RESERVATION_LIMIT');
  clock = 111;
  assert.equal(coordinator.reserve(identity('run-b', 'session-b')).ok, true);
  coordinator.cancel('unknown-a');
  coordinator.cancel('unknown-b');
  coordinator.cancel('unknown-c');
  assert.equal(coordinator.snapshot().tombstones, 2);
  clock = 132;
  assert.equal(coordinator.snapshot().tombstones, 0);
});

test('run coordinator consumes exact reservations and makes pre-start cancellation sticky', () => {
  const coordinator = createRunCoordinator();
  assert.equal(coordinator.admit(identity('missing')).code, 'RUN_NOT_RESERVED');
  assert.equal(coordinator.reserve(identity('run-a')).ok, true);
  assert.equal(coordinator.admit({ ...identity('run-a'), tabId: 8 }).code, 'RUN_RESERVATION_MISMATCH');
  assert.equal(coordinator.cancel('run-a').reserved, true);
  assert.equal(coordinator.admit(identity('run-a')).code, 'CANCELLED');
});
