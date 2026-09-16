'use strict';

// Centres operate on India's calendar day, not the host machine's -- a
// server left in its default UTC timezone (typical for a cloud VM) would
// otherwise think "today" is still yesterday for the first 5.5 hours of
// every IST day, letting past-dated bookings (and gate scans) through.
// Deriving the date from an IST-shifted instant sidesteps the host's TZ
// setting entirely.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function todayInIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { todayInIST };
