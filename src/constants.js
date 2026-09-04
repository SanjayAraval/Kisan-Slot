'use strict';

// Shared business constants -- used by both the booking API and the seed
// script, so seeded data and live bookings are judged by the same rules.
module.exports = {
  YIELD_QUINTALS_PER_ACRE: 24,
  BAGS_PER_QUINTAL: 2.5,
  OVER_DECLARE_CAP_MULTIPLIER: 1.3,
  NEARBY_CENTRE_RADIUS_KM: 25,
  ALT_DATE_SEARCH_HORIZON_DAYS: 30,

  // Nightly reallocation: how much each factor moves a booking's
  // allocation score. Higher score = kept; lowest scores are deferred
  // first when confirmed bookings exceed recomputed capacity.
  ALLOCATION_SCORE_WEIGHTS: {
    daysWaiting: 5, // per day since booked -- longer-waiting bookings are protected
    smallholderPriority: 10, // per acre below SMALLHOLDER_REFERENCE_ACRES
    priorDeferrals: 15, // per previous deferral -- anti-starvation
    distanceKm: 1, // subtracted per km -- farther bookings deprioritized
    lotSizeDeviationRatio: 20, // subtracted per unit deviation from land estimate
  },
  SMALLHOLDER_REFERENCE_ACRES: 5, // farms at/above this get zero smallholder priority
  RECOMPUTE_HORIZON_DAYS: 7, // D+1 .. D+7
  SERVICE_TIME_EWMA_ALPHA: 0.3,
  DEFERRAL_REASON_CAPACITY_REDUCED: 'capacity_reduced',
};
