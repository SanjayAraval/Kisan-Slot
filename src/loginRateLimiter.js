'use strict';

// Lockout for the officer/operator employeeId+password login (see
// authRoutes.js) -- farmers never hit this, they authenticate by mobile
// OTP instead. In-memory only: fine for this single-process demo, but a
// horizontally-scaled deployment would need a shared store (Redis, per
// CLAUDE.md's stack) instead, since each process would otherwise keep
// its own independent counter.
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

// employeeId (normalized) -> array of failed-attempt timestamps (ms)
// still inside the current window.
const failedAttempts = new Map();

function normalizeKey(employeeId) {
  return String(employeeId || '').trim().toLowerCase();
}

// Drops timestamps older than the window and returns what's left,
// deleting the map entry entirely once nothing recent remains -- keeps
// memory bounded for an employeeId nobody has mistyped in a while.
function pruneExpired(key, now) {
  const attempts = failedAttempts.get(key);
  if (!attempts) return [];
  const cutoff = now - LOCKOUT_WINDOW_MS;
  const fresh = attempts.filter((t) => t > cutoff);
  if (fresh.length === 0) {
    failedAttempts.delete(key);
  } else {
    failedAttempts.set(key, fresh);
  }
  return fresh;
}

function isLockedOut(employeeId, now = Date.now()) {
  return pruneExpired(normalizeKey(employeeId), now).length >= MAX_FAILED_ATTEMPTS;
}

function recordFailedLoginAttempt(employeeId, now = Date.now()) {
  const key = normalizeKey(employeeId);
  const fresh = pruneExpired(key, now);
  fresh.push(now);
  failedAttempts.set(key, fresh);
}

// Called on a successful login -- a legitimate sign-in clears the slate
// rather than leaving a near-miss count hanging over the account.
function clearFailedLoginAttempts(employeeId) {
  failedAttempts.delete(normalizeKey(employeeId));
}

module.exports = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_WINDOW_MS,
  isLockedOut,
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
};
