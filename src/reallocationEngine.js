'use strict';

const { computeDailyCapacity } = require('./capacityEngine');
const {
  YIELD_QUINTALS_PER_ACRE,
  ALLOCATION_SCORE_WEIGHTS,
  SMALLHOLDER_REFERENCE_ACRES,
  SERVICE_TIME_EWMA_ALPHA,
  DEFERRAL_REASON_CAPACITY_REDUCED,
} = require('./constants');

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function daysBetween(laterDate, earlierIso) {
  const later = Date.parse(`${laterDate}T00:00:00Z`);
  const earlier = Date.parse(earlierIso);
  return Math.max(0, Math.floor((later - earlier) / 86400000));
}

// Smaller farms get more priority; farms at or above the reference size
// get none. Linear, capped at zero -- no bonus for "very large".
function smallholderPriority(extentAcres) {
  return Math.max(0, SMALLHOLDER_REFERENCE_ACRES - extentAcres);
}

// How far the farmer's declared quantity deviates from what their land
// record would suggest, as a ratio (0 = exact match).
function lotSizeDeviationRatio(declaredQuantityQuintals, extentAcres) {
  const estimate = extentAcres * YIELD_QUINTALS_PER_ACRE;
  if (estimate <= 0) return 0;
  return Math.abs(declaredQuantityQuintals - estimate) / estimate;
}

// Higher score = higher priority to keep the slot. Lowest-scored bookings
// are the ones deferred when confirmed bookings exceed capacity.
function computeAllocationScore({ daysWaiting, extentAcres, priorDeferrals, distanceKm = 0, lotSizeDeviationRatio: deviation = 0 }) {
  const w = ALLOCATION_SCORE_WEIGHTS;
  return round(
    daysWaiting * w.daysWaiting +
      smallholderPriority(extentAcres) * w.smallholderPriority +
      priorDeferrals * w.priorDeferrals -
      distanceKm * w.distanceKm -
      deviation * w.lotSizeDeviationRatio,
    2
  );
}

// Greedily defers lowest-scored bookings (ties broken by earliest
// booked_at, then bookingId, for determinism) until the kept total fits
// bagsCapacity. Returns just the deferred ones, in the order deferred.
function selectDeferrals(scoredBookings, bagsCapacity) {
  const sorted = [...scoredBookings].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Tied on score: defer the more-recently-booked one first, consistent
    // with daysWaiting rewarding whoever has been waiting longer.
    const bookedDiff = Date.parse(b.bookedAt) - Date.parse(a.bookedAt);
    if (bookedDiff !== 0) return bookedDiff;
    return a.bookingId < b.bookingId ? -1 : a.bookingId > b.bookingId ? 1 : 0;
  });

  let totalBags = scoredBookings.reduce((sum, b) => sum + b.bagsReserved, 0);
  const deferred = [];
  for (const candidate of sorted) {
    if (totalBags <= bagsCapacity) break;
    deferred.push(candidate);
    totalBags -= candidate.bagsReserved;
  }
  return deferred;
}

function averageServiceMinutes(completedLots) {
  const durations = completedLots
    .filter((l) => l.checkedInAt && l.completedAt)
    .map((l) => (Date.parse(l.completedAt) - Date.parse(l.checkedInAt)) / 60000)
    .filter((minutes) => minutes > 0);
  if (durations.length === 0) return null;
  return durations.reduce((sum, m) => sum + m, 0) / durations.length;
}

function updateEwma(currentEwma, observedMinutes, alpha = SERVICE_TIME_EWMA_ALPHA) {
  if (currentEwma === null || currentEwma === undefined) return round(observedMinutes, 2);
  return round(alpha * observedMinutes + (1 - alpha) * currentEwma, 2);
}

function deferralNotificationBody(centreCode, date) {
  return `Your booking for ${date} at ${centreCode} has been deferred due to reduced capacity. We will contact you with a new date.`;
}

/**
 * The nightly reallocation job's entire decision logic, as one pure
 * function: no I/O, no Date.now(), no randomness -- everything it needs
 * is in `snapshot`, everything it decides comes back in the returned plan
 * for the runner to apply.
 *
 * @param {object} snapshot
 * @param {string} snapshot.today - 'YYYY-MM-DD', the job's run date (D)
 * @param {Array} snapshot.centres - per-centre state:
 *   - centreId, code
 *   - today: { noShowBookings: [{bookingId, bagsReserved}] }
 *   - futureDates: [{
 *       date,                          // D+1 .. D+7
 *       dailyInputEngineInput,         // capacityEngine input, or null if the centre has no data that date
 *       confirmedBookings: [{ bookingId, farmerId, bagsReserved, bookedAt,
 *                              extentAcres, declaredQuantityQuintals,
 *                              priorDeferrals, distanceKm }],
 *     }]
 *   - completedLotsToday: [{ checkedInAt, completedAt }]
 *   - currentEwmaMinutes: number | null
 * @returns {{
 *   centreDayUpserts: Array,   // D+1..D+7 recomputed capacity, to persist
 *   noShowReleases: Array,     // today's no-shows to release
 *   deferrals: Array,          // bookings to bump, with score + reason
 *   ewmaUpdates: Array,        // per-centre new service-time EWMA
 *   notifications: Array,      // one per deferral, for the mock gateway
 * }}
 */
function planNightlyReallocation({ today, centres }) {
  const centreDayUpserts = [];
  const noShowReleases = [];
  const deferrals = [];
  const ewmaUpdates = [];
  const notifications = [];

  for (const centre of centres) {
    for (const noShow of centre.today.noShowBookings) {
      noShowReleases.push({
        bookingId: noShow.bookingId,
        centreId: centre.centreId,
        bagsReleased: noShow.bagsReserved,
      });
    }

    for (const futureDate of centre.futureDates) {
      if (!futureDate.dailyInputEngineInput) continue; // no operating data -- nothing to recompute

      const engineResult = computeDailyCapacity(futureDate.dailyInputEngineInput);
      const bagsPerTruck = futureDate.dailyInputEngineInput.bagsPerTruck;
      const bagsCapacity = engineResult.bookableCapacity * bagsPerTruck;

      centreDayUpserts.push({
        centreId: centre.centreId,
        date: futureDate.date,
        engineResult,
        bagsCapacity,
      });

      const totalBags = futureDate.confirmedBookings.reduce((sum, b) => sum + b.bagsReserved, 0);
      if (totalBags <= bagsCapacity) continue;

      const scored = futureDate.confirmedBookings.map((b) => ({
        ...b,
        score: computeAllocationScore({
          daysWaiting: daysBetween(today, b.bookedAt),
          extentAcres: b.extentAcres,
          priorDeferrals: b.priorDeferrals,
          distanceKm: b.distanceKm,
          lotSizeDeviationRatio: lotSizeDeviationRatio(b.declaredQuantityQuintals, b.extentAcres),
        }),
      }));

      for (const bumped of selectDeferrals(scored, bagsCapacity)) {
        deferrals.push({
          bookingId: bumped.bookingId,
          farmerId: bumped.farmerId,
          centreId: centre.centreId,
          date: futureDate.date,
          score: bumped.score,
          bagsReleased: bumped.bagsReserved,
          reason: DEFERRAL_REASON_CAPACITY_REDUCED,
        });
        notifications.push({
          farmerId: bumped.farmerId,
          relatedBookingId: bumped.bookingId,
          body: deferralNotificationBody(centre.code, futureDate.date),
        });
      }
    }

    const observed = averageServiceMinutes(centre.completedLotsToday);
    if (observed !== null) {
      ewmaUpdates.push({
        centreId: centre.centreId,
        newEwmaMinutes: updateEwma(centre.currentEwmaMinutes, observed),
      });
    }
  }

  return { centreDayUpserts, noShowReleases, deferrals, ewmaUpdates, notifications };
}

module.exports = {
  planNightlyReallocation,
  computeAllocationScore,
  smallholderPriority,
  lotSizeDeviationRatio,
  selectDeferrals,
  averageServiceMinutes,
  updateEwma,
};
