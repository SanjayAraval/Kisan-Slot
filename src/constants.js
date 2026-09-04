'use strict';

// Shared business constants -- used by both the booking API and the seed
// script, so seeded data and live bookings are judged by the same rules.
module.exports = {
  YIELD_QUINTALS_PER_ACRE: 24,
  BAGS_PER_QUINTAL: 2.5,
  OVER_DECLARE_CAP_MULTIPLIER: 1.3,
  NEARBY_CENTRE_RADIUS_KM: 25,
  ALT_DATE_SEARCH_HORIZON_DAYS: 30,
};
