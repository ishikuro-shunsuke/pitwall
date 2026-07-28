import { config } from './config.mjs';

/**
 * A hook that reports a waiting agent keeps an HTTP request open until you act
 * on the entry in the browser. This registry is the hand-off point between the
 * two halves of that exchange.
 *
 * Hybrid hold: each slot starts with a soft deadline. Opening the reply
 * composer sends heartbeats that push it forward, up to maxHoldSeconds from
 * creation. When the deadline elapses with no action the waiter resolves with
 * `{ action: 'release', reason: 'expired' }`.
 */
const slots = new Map();

function now() {
  return Date.now();
}

function deadlineFor(createdAtMs, softSeconds, fromMs = now()) {
  const soft = fromMs + softSeconds * 1000;
  const hard = createdAtMs + config.maxHoldSeconds * 1000;
  return Math.min(soft, hard);
}

/**
 * Opened when the entry is created, before the hook starts polling. The clock
 * starts here rather than at the first poll: a hook can die in between, and a
 * slot nobody ever polls still must not outlive its hold. `onExpire` is how the
 * owner hears about that case, since no long poll is around to be released.
 */
export function reserve(entryId, {
  createdAtMs = now(),
  softHoldSeconds = config.holdSeconds,
  onExpire = null,
} = {}) {
  if (slots.has(entryId)) return slots.get(entryId);
  const slot = {
    createdAtMs,
    softHoldSeconds,
    deadlineMs: deadlineFor(createdAtMs, softHoldSeconds),
    resolution: null,
    settle: null,
    abandon: null,
    onExpire,
    timer: null,
  };
  slots.set(entryId, slot);
  armTimer(entryId);
  return slot;
}

function armTimer(entryId) {
  const slot = slots.get(entryId);
  if (!slot) return;

  if (slot.timer) clearTimeout(slot.timer);
  const remaining = Math.max(0, slot.deadlineMs - now());
  slot.timer = setTimeout(() => {
    // Re-check identity, not just presence: the id may have been reserved again.
    if (slots.get(entryId) !== slot) return;
    slots.delete(entryId);

    if (slot.settle) {
      const settle = slot.settle;
      slot.settle = null;
      settle({ action: 'release', reason: 'expired' });
      return;
    }
    // A stashed resolution was already recorded by whoever stashed it, so the
    // slot just goes. An untouched one leaves an entry nobody has retired.
    if (!slot.resolution) slot.onExpire?.();
  }, remaining);
  slot.timer.unref?.();
}

/**
 * Long-poll side. Resolves with the resolution object:
 *   { action: 'reply', message }
 *   { action: 'dismiss' }
 *   { action: 'release', reason: 'expired' | 'detached' | ... }
 *   { action: 'pending' }   — only when `pendingAfterMs` is set
 *
 * `pendingAfterMs` is for a caller that cannot hold one request open for the
 * whole wait and will poll again. It gets the poll back with nothing decided,
 * and the slot stays exactly as it was.
 */
export function waitFor(entryId, { pendingAfterMs = 0 } = {}) {
  const slot = slots.get(entryId);
  if (!slot) return Promise.resolve({ action: 'release', reason: 'missing' });
  if (slot.resolution) {
    const resolution = slot.resolution;
    slots.delete(entryId);
    return Promise.resolve(resolution);
  }

  return new Promise((resolvePromise) => {
    let pendingTimer = null;
    slot.settle = (resolution) => {
      if (pendingTimer) clearTimeout(pendingTimer);
      if (slot.timer) clearTimeout(slot.timer);
      slot.settle = null;
      slot.abandon = null;
      slots.delete(entryId);
      resolvePromise(resolution);
    };
    // Hand the poll back without retiring the slot. The deadline stays armed, so
    // the entry still expires on its own clock, and a reply that lands before
    // the next poll is stashed rather than lost.
    slot.abandon = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      slot.settle = null;
      slot.abandon = null;
      resolvePromise({ action: 'pending' });
    };
    if (pendingAfterMs > 0) {
      pendingTimer = setTimeout(() => slot.abandon?.(), pendingAfterMs);
      pendingTimer.unref?.();
    }
    armTimer(entryId);
  });
}

/** The poll went away but is coming back. Opposite of `drop`. */
export function unwait(entryId) {
  slots.get(entryId)?.abandon?.();
}

/**
 * Browser side. 'delivered' when a hook was polling and took it, 'stashed' when
 * the slot is open but nothing is polling yet, false when the agent has already
 * moved on and the resolution cannot be delivered at all.
 *
 * A stash is only a bet that the hook comes back — it may have died between
 * registering and polling — so the caller still owns the entry's status.
 */
export function resolve(entryId, resolution) {
  const slot = slots.get(entryId);
  if (!slot) return false;
  if (slot.settle) {
    slot.settle(resolution);
    return 'delivered';
  }
  slot.resolution = resolution;
  // Leave the deadline armed. If the hook never comes back to collect this, the
  // slot is dropped on time instead of sitting in the map for good.
  return 'stashed';
}

/**
 * Heartbeat from the reply composer. Extends the soft deadline by holdSeconds
 * without exceeding the hard maxHoldSeconds ceiling.
 * Returns the new deadline ms, or null if the slot is gone.
 */
export function extendHold(entryId) {
  const slot = slots.get(entryId);
  if (!slot) return null;
  if (slot.resolution) return null;

  const next = deadlineFor(slot.createdAtMs, slot.softHoldSeconds);
  if (next <= slot.deadlineMs && next <= now()) {
    // Already at the hard ceiling and past it — nothing to do.
    return slot.deadlineMs;
  }
  slot.deadlineMs = Math.max(slot.deadlineMs, next);
  armTimer(entryId);
  return slot.deadlineMs;
}

export function getHoldInfo(entryId) {
  const slot = slots.get(entryId);
  if (!slot) return null;
  return {
    createdAtMs: slot.createdAtMs,
    deadlineMs: slot.deadlineMs,
    remainingMs: Math.max(0, slot.deadlineMs - now()),
    maxHoldMs: config.maxHoldSeconds * 1000,
  };
}

export function isLive(entryId) {
  return slots.has(entryId);
}

/** Called when the hook's connection drops before we could answer it. */
export function drop(entryId) {
  const slot = slots.get(entryId);
  if (!slot) return;
  if (slot.timer) clearTimeout(slot.timer);
  if (slot.settle) {
    const settle = slot.settle;
    slot.settle = null;
    slots.delete(entryId);
    settle({ action: 'release', reason: 'detached' });
    return;
  }
  slots.delete(entryId);
}
