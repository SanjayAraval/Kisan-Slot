'use strict';

const {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_WINDOW_MS,
  isLockedOut,
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
} = require('./loginRateLimiter');

describe('loginRateLimiter', () => {
  test('constants match the spec: 10 attempts, 15-minute window', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(10);
    expect(LOCKOUT_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  test('not locked out with no failures on record', () => {
    expect(isLockedOut('CO-unit-001')).toBe(false);
  });

  test('locks out after exactly MAX_FAILED_ATTEMPTS failures', () => {
    const id = 'CO-unit-002';
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) recordFailedLoginAttempt(id);
    expect(isLockedOut(id)).toBe(false); // one short of the threshold

    recordFailedLoginAttempt(id);
    expect(isLockedOut(id)).toBe(true);
  });

  test('is keyed per employeeId -- failures on one account do not lock out another', () => {
    const id = 'CO-unit-003';
    const other = 'CO-unit-004';
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedLoginAttempt(id);
    expect(isLockedOut(id)).toBe(true);
    expect(isLockedOut(other)).toBe(false);
  });

  test('is case/whitespace-insensitive on the employeeId', () => {
    const id = 'CO-unit-005';
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedLoginAttempt(id);
    expect(isLockedOut(' co-unit-005 ')).toBe(true);
  });

  test('a successful login clears the failure count', () => {
    const id = 'CO-unit-006';
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedLoginAttempt(id);
    expect(isLockedOut(id)).toBe(true);

    clearFailedLoginAttempts(id);
    expect(isLockedOut(id)).toBe(false);
  });

  test('failures older than the 15-minute window no longer count towards lockout', () => {
    const id = 'CO-unit-007';
    const longAgo = Date.now() - (LOCKOUT_WINDOW_MS + 60 * 1000); // 16 minutes ago
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedLoginAttempt(id, longAgo);
    expect(isLockedOut(id, longAgo)).toBe(true); // locked out at the time of those attempts

    // ...but checked "now", those attempts have aged out of the window.
    expect(isLockedOut(id, Date.now())).toBe(false);
  });

  test('a mix of old and recent failures only counts the recent ones', () => {
    const id = 'CO-unit-008';
    const now = Date.now();
    const longAgo = now - (LOCKOUT_WINDOW_MS + 60 * 1000);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedLoginAttempt(id, longAgo);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) recordFailedLoginAttempt(id, now);

    expect(isLockedOut(id, now)).toBe(false); // only 9 of the 19 recorded attempts are still in-window

    recordFailedLoginAttempt(id, now);
    expect(isLockedOut(id, now)).toBe(true); // the 10th recent failure tips it over
  });
});
