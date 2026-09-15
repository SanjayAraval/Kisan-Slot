'use strict';

const { computeCentreDayCapacity, upsertCentreDay, loadDailyInputs } = require('./capacityService');
const { bagsToSlots } = require('./bookingService');
const { KG_PER_BAG } = require('./constants');

const AT_RISK_DAYS_OF_COVER_THRESHOLD = 1.5;
const BURN_RATE_WINDOW_DAYS = 3;

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Rolling burn rate: average bags actually consumed per day, over the
// BURN_RATE_WINDOW_DAYS calendar days immediately before `date` -- never
// `date` itself or later, since those lots haven't happened yet. Uses the
// same per-lot rounding as the real draw-down in lotService's
// recordWeighment (Math.round(netKg / KG_PER_BAG)) summed across lots, not
// a SQL-side aggregate, so this always agrees with what actually got
// deducted from gunny stock.
async function computeBurnRate(client, centreId, date) {
  const windowStart = addDays(date, -BURN_RATE_WINDOW_DAYS);
  const result = await client.query(
    `SELECT lw.net_kg
     FROM lot_weighments lw
     JOIN bookings b ON b.id = lw.booking_id
     JOIN centre_day cd ON cd.id = b.centre_day_id
     WHERE cd.centre_id = $1 AND cd.service_date >= $2 AND cd.service_date < $3`,
    [centreId, windowStart, date]
  );
  const totalBags = result.rows.reduce((sum, r) => sum + Math.round(Number(r.net_kg) / KG_PER_BAG), 0);
  return round(totalBags / BURN_RATE_WINDOW_DAYS, 2);
}

// Days the current gunny stock will last at the recent burn rate. null
// when there's no burn history to divide by -- distinct from 0 (out of
// bags right now), and avoids Infinity, which doesn't round-trip JSON.
function daysOfCover(bagsRemaining, burnRate) {
  if (burnRate <= 0) return null;
  return round(bagsRemaining / burnRate, 1);
}

// One centre's row for the dashboard grid, or null if it has no declared
// inputs for `date` at all (not operating that day). Capacity is always
// recomputed live from centre_daily_inputs -- same rule the availability
// endpoint follows -- never trusted from a possibly-stale centre_day
// snapshot; bags_booked is read from that snapshot, since it (not the
// engine) is the actual reservation ledger.
async function loadCentreRow(client, centre, date) {
  const capacity = await computeCentreDayCapacity(client, centre.id, date);
  if (!capacity) return null;

  const centreDayResult = await client.query(
    'SELECT bags_booked FROM centre_day WHERE centre_id = $1 AND service_date = $2',
    [centre.id, date]
  );
  const bagsBooked = centreDayResult.rows[0] ? Number(centreDayResult.rows[0].bags_booked) : 0;
  const bookedSlots = bagsToSlots(bagsBooked, capacity.bagsPerTruck);

  const burnRatePerDay = await computeBurnRate(client, centre.id, date);
  const gunnyBagsAvailable = Number(capacity.dailyInputRow.gunny_bags_available);
  const cover = daysOfCover(gunnyBagsAvailable, burnRatePerDay);

  // bags_capacity is already the bookable-only pool (walk-in reserve
  // excluded -- see capacityService's computeCentreDayCapacity), and the
  // atomic claim in bookingService never lets bags_booked exceed it, so
  // "overbooked" here means fully subscribed: no bookable room left.
  const overbooked = capacity.bagsCapacity > 0 && bagsBooked >= capacity.bagsCapacity;
  const atRisk = overbooked || (cover !== null && cover < AT_RISK_DAYS_OF_COVER_THRESHOLD);

  return {
    centreId: centre.id,
    name: centre.name,
    code: centre.code,
    centreType: centre.centre_type,
    weighingMode: capacity.dailyInputRow.weighing_mode,
    totalCapacity: capacity.engineResult.totalCapacity,
    bookableCapacity: capacity.engineResult.bookableCapacity,
    bookedSlots,
    bindingConstraint: capacity.engineResult.bindingConstraint,
    bindingConstraints: capacity.engineResult.bindingConstraints,
    gunnyBagsAvailable,
    burnRatePerDay,
    daysOfCover: cover,
    overbooked,
    atRisk,
    yardCapacityTonnes: Number(capacity.dailyInputRow.yard_capacity_tonnes),
    undispatchedTonnes: Number(capacity.dailyInputRow.undispatched_tonnes),
  };
}

// Urgency order for the centre grid: overbooked centres first (no
// bookable room left, right now), then ascending days-of-cover -- least
// cover first. A centre with no burn history (null cover) sorts as if it
// had ample cover -- unknown isn't the same as urgent.
function byUrgency(a, b) {
  if (a.overbooked !== b.overbooked) return a.overbooked ? -1 : 1;
  const aCover = a.daysOfCover === null ? Infinity : a.daysOfCover;
  const bCover = b.daysOfCover === null ? Infinity : b.daysOfCover;
  return aCover - bCover;
}

function alertReason(row) {
  const lowCover = row.daysOfCover !== null && row.daysOfCover < AT_RISK_DAYS_OF_COVER_THRESHOLD;
  if (row.overbooked && lowCover) return 'overbooked_and_low_bag_cover';
  if (row.overbooked) return 'overbooked';
  return 'low_bag_cover';
}

// Everything the district officer dashboard needs for one date, in one
// read: header stats, the sorted centre grid, at-risk alerts drawn from
// it, and the evacuation backlog. Centres without a declaration on file
// for `date` are simply absent -- not "operating" that day. Scoped to
// `district` throughout -- a district officer sees their own district,
// never the whole state.
async function loadDistrictDashboard(pool, date, district) {
  const centresResult = await pool.query('SELECT id, name, code, centre_type FROM centres WHERE district = $1 ORDER BY name', [district]);

  const rows = [];
  for (const centre of centresResult.rows) {
    const row = await loadCentreRow(pool, centre, date);
    if (row) rows.push(row);
  }
  rows.sort(byUrgency);

  const bookingsResult = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM bookings b
     JOIN centre_day cd ON cd.id = b.centre_day_id
     JOIN centres c ON c.id = cd.centre_id
     WHERE cd.service_date = $1 AND c.district = $2 AND b.status != 'cancelled' AND b.status != 'deferred'`,
    [date, district]
  );

  const alerts = rows
    .filter((r) => r.atRisk)
    .map((r) => ({
      centreId: r.centreId,
      name: r.name,
      code: r.code,
      daysOfCover: r.daysOfCover,
      gunnyBagsAvailable: r.gunnyBagsAvailable,
      burnRatePerDay: r.burnRatePerDay,
      overbooked: r.overbooked,
      bookedSlots: r.bookedSlots,
      bookableCapacity: r.bookableCapacity,
      reason: alertReason(r),
    }));

  const evacuationBacklog = rows
    .map((r) => ({
      centreId: r.centreId,
      name: r.name,
      code: r.code,
      undispatchedTonnes: r.undispatchedTonnes,
      yardCapacityTonnes: r.yardCapacityTonnes,
      yardUtilization: r.yardCapacityTonnes > 0 ? round(r.undispatchedTonnes / r.yardCapacityTonnes, 3) : 0,
    }))
    .sort((a, b) => b.yardUtilization - a.yardUtilization);

  return {
    date,
    summary: {
      centresOperating: rows.length,
      totalDistrictCapacity: rows.reduce((sum, r) => sum + r.totalCapacity, 0),
      bookingsForDate: bookingsResult.rows[0].n,
      centresAtRisk: alerts.length,
    },
    centres: rows,
    alerts,
    evacuationBacklog,
  };
}

// Adds bags to a centre's already-declared gunny stock for `date` and
// recomputes/persists capacity off the back of it -- the same
// declare-then-recompute sequence declarationRoutes uses, just adding to
// an existing declaration instead of replacing it wholesale. Runs inside
// the caller's transaction (see dashboardRoutes).
async function releaseBags(client, centreId, date, additionalBags) {
  const dailyInputRow = await loadDailyInputs(client, centreId, date);
  if (!dailyInputRow) {
    return { type: 'NOT_FOUND', message: 'no declaration on file for this centre and date' };
  }

  await client.query(
    'UPDATE centre_daily_inputs SET gunny_bags_available = gunny_bags_available + $1::int WHERE centre_id = $2 AND service_date = $3',
    [additionalBags, centreId, date]
  );

  const capacity = await computeCentreDayCapacity(client, centreId, date);
  await upsertCentreDay(client, centreId, date, capacity);

  return {
    type: 'OK',
    centreId,
    date,
    gunnyBagsAvailable: Number(dailyInputRow.gunny_bags_available) + additionalBags,
    totalCapacity: capacity.engineResult.totalCapacity,
    bookableCapacity: capacity.engineResult.bookableCapacity,
    bindingConstraint: capacity.engineResult.bindingConstraint,
    bindingConstraints: capacity.engineResult.bindingConstraints,
  };
}

module.exports = {
  loadDistrictDashboard,
  releaseBags,
  computeBurnRate,
  daysOfCover,
  AT_RISK_DAYS_OF_COVER_THRESHOLD,
  BURN_RATE_WINDOW_DAYS,
};
