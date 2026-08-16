const DEFAULT_RESERVATION_TTL_MS = 30_000;
const DEFAULT_TOMBSTONE_TTL_MS = 30_000;
const DEFAULT_MAX_RESERVATIONS = 256;
const DEFAULT_MAX_TOMBSTONES = 512;

function sessionKey(identity) {
  return `${identity.projectId}\u0000${identity.sessionId}`;
}

function sameIdentity(left, right) {
  return left?.runId === right?.runId
    && left?.tabId === right?.tabId
    && left?.projectId === right?.projectId
    && left?.sessionId === right?.sessionId;
}

/**
 * Owns bounded reservation, session admission, and pre-start cancellation
 * state. The injected clock keeps expiry behavior deterministic in tests.
 */
export function createRunCoordinator(options = {}) {
  const now = options.now || (() => Date.now());
  const reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  const tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
  const maxReservations = options.maxReservations ?? DEFAULT_MAX_RESERVATIONS;
  const maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
  const reservations = new Map();
  const active = new Map();
  const sessionOwners = new Map();
  const tombstones = new Map();

  function releaseReservation(runId) {
    const reservation = reservations.get(runId);
    if (!reservation) return null;
    reservations.delete(runId);
    const key = sessionKey(reservation);
    if (sessionOwners.get(key) === runId) sessionOwners.delete(key);
    return reservation;
  }

  function prune() {
    const current = now();
    for (const [runId, reservation] of reservations) {
      if (reservation.expiresAt <= current) releaseReservation(runId);
    }
    for (const [runId, expiresAt] of tombstones) {
      if (expiresAt <= current) tombstones.delete(runId);
    }
  }

  function retainTombstone(runId) {
    prune();
    tombstones.delete(runId);
    tombstones.set(runId, now() + tombstoneTtlMs);
    while (tombstones.size > maxTombstones) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  return Object.freeze({
    reserve(identity) {
      prune();
      if (tombstones.has(identity.runId)) {
        return { ok: false, code: 'CANCELLED', error: 'Run was cancelled before it could be reserved.' };
      }
      const existing = reservations.get(identity.runId);
      if (existing) {
        return sameIdentity(existing, identity)
          ? { ok: true, reserved: true, expiresAt: existing.expiresAt }
          : { ok: false, code: 'DUPLICATE_RUN_ID', error: 'The run ID is already reserved for different context.' };
      }
      if (active.has(identity.runId)) {
        return { ok: false, code: 'DUPLICATE_RUN_ID', error: 'The run ID is already active.' };
      }
      const key = sessionKey(identity);
      const owner = sessionOwners.get(key);
      if (owner && owner !== identity.runId) {
        return { ok: false, code: 'SESSION_RUN_ACTIVE', error: 'Another run already owns this chat.' };
      }
      if (reservations.size >= maxReservations) {
        return { ok: false, code: 'RUN_RESERVATION_LIMIT', error: 'Too many runs are waiting to start.' };
      }
      const reservation = Object.freeze({ ...identity, expiresAt: now() + reservationTtlMs });
      reservations.set(identity.runId, reservation);
      sessionOwners.set(key, identity.runId);
      return { ok: true, reserved: true, expiresAt: reservation.expiresAt };
    },

    admit(identity) {
      prune();
      if (tombstones.has(identity.runId)) {
        tombstones.delete(identity.runId);
        releaseReservation(identity.runId);
        return { ok: false, code: 'CANCELLED', error: 'Run was cancelled before it started.' };
      }
      if (active.has(identity.runId)) {
        return { ok: false, code: 'DUPLICATE_RUN_ID', error: 'The run ID is already active.' };
      }
      const reservation = reservations.get(identity.runId);
      if (!reservation) {
        return { ok: false, code: 'RUN_NOT_RESERVED', error: 'Run must be reserved before it starts.' };
      }
      if (!sameIdentity(reservation, identity)) {
        return { ok: false, code: 'RUN_RESERVATION_MISMATCH', error: 'Run start does not match its reservation.' };
      }
      reservations.delete(identity.runId);
      active.set(identity.runId, Object.freeze({ ...identity }));
      return { ok: true };
    },

    cancel(runId) {
      prune();
      const isActive = active.has(runId);
      const reservation = isActive ? null : releaseReservation(runId);
      if (!isActive) retainTombstone(runId);
      return { ok: true, found: isActive || !!reservation, active: isActive, reserved: !!reservation };
    },

    complete(runId) {
      prune();
      releaseReservation(runId);
      const identity = active.get(runId);
      if (!identity) return false;
      active.delete(runId);
      const key = sessionKey(identity);
      if (sessionOwners.get(key) === runId) sessionOwners.delete(key);
      return true;
    },

    snapshot() {
      prune();
      return Object.freeze({
        reservations: reservations.size,
        active: active.size,
        tombstones: tombstones.size
      });
    },

    reset() {
      reservations.clear();
      active.clear();
      sessionOwners.clear();
      tombstones.clear();
    }
  });
}
