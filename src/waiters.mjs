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

/** Opened when the entry is created, before the hook starts polling. */
export function reserve(entryId, { createdAtMs = now(), softHoldSeconds = config.holdSeconds } = {}) {
  if (slots.has(entryId)) return slots.get(entryId);
  const slot = {
    createdAtMs,
    softHoldSeconds,
    deadlineMs: deadlineFor(createdAtMs, softHoldSeconds),
    resolution: null,
    settle: null,
    timer: null,
  };
  slots.set(entryId, slot);
  return slot;
}

function armTimer(entryId) {
  const slot = slots.get(entryId);
  if (!slot || slot.settle == null) return;

  if (slot.timer) clearTimeout(slot.timer);
  const remaining = Math.max(0, slot.deadlineMs - now());
  slot.timer = setTimeout(() => {
    if (!slots.has(entryId)) return;
    if (slot.settle) {
      const settle = slot.settle;
      slot.settle = null;
      if (slot.timer) clearTimeout(slot.timer);
      slots.delete(entryId);
      settle({ action: 'release', reason: 'expired' });
    }
  }, remaining);
  slot.timer.unref?.();
}

/**
 * Long-poll side. Resolves with the resolution object:
 *   { action: 'reply', message }
 *   { action: 'dismiss' }
 *   { action: 'release', reason: 'expired' | 'detached' | ... }
 */
export function waitFor(entryId) {
  const slot = slots.get(entryId);
  if (!slot) return Promise.resolve({ action: 'release', reason: 'missing' });
  if (slot.resolution) {
    const resolution = slot.resolution;
    slots.delete(entryId);
    return Promise.resolve(resolution);
  }

  return new Promise((resolvePromise) => {
    slot.settle = (resolution) => {
      if (slot.timer) clearTimeout(slot.timer);
      slot.settle = null;
      slots.delete(entryId);
      resolvePromise(resolution);
    };
    armTimer(entryId);
  });
}

/**
 * Browser side. Returns false when the agent has already moved on, in which
 * case the resolution cannot be delivered.
 */
export function resolve(entryId, resolution) {
  const slot = slots.get(entryId);
  if (!slot) return false;
  if (slot.settle) {
    slot.settle(resolution);
    return true;
  }
  slot.resolution = resolution;
  if (slot.timer) clearTimeout(slot.timer);
  return true;
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
  if (slot.settle) armTimer(entryId);
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
