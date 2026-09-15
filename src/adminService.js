'use strict';

const { findAlternatives } = require('./bookingService');

// Builds a "$1, $2, ..." placeholder list starting at $1 -- small, bounded
// id lists only (a reallocation plan touches at most a handful of
// centres/farmers per run), so a dynamic IN-list is simpler here than an
// array-typed parameter.
function placeholders(values) {
  return values.map((_, i) => `$${i + 1}`).join(', ');
}

// Centres table is tiny (one district's worth) -- always fetched whole
// rather than filtered, which sidesteps building an IN-list for it.
async function loadCentreDisplayNames(pool) {
  const result = await pool.query('SELECT id, name, code FROM centres');
  return new Map(result.rows.map((r) => [r.id, { centreName: r.name, centreCode: r.code }]));
}

async function loadFarmerDisplayNames(pool, farmerIds) {
  const ids = [...new Set(farmerIds)];
  if (ids.length === 0) return new Map();
  const result = await pool.query(`SELECT id, farmer_name, phone FROM farmers WHERE id IN (${placeholders(ids)})`, ids);
  return new Map(result.rows.map((r) => [r.id, { name: r.farmer_name, phone: r.phone }]));
}

// no-show releases only carry a bookingId (see reallocationEngine's
// snapshot shape) -- this resolves each one to the farmer who no-showed,
// for display.
async function loadBookingFarmers(pool, bookingIds) {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return new Map();
  const result = await pool.query(
    `SELECT b.id AS booking_id, f.farmer_name, f.phone
     FROM bookings b JOIN farmers f ON f.id = b.farmer_id
     WHERE b.id IN (${placeholders(ids)})`,
    ids
  );
  return new Map(result.rows.map((r) => [r.booking_id, { name: r.farmer_name, phone: r.phone }]));
}

// Turns planNightlyReallocation's plan (bare ids and engine output, meant
// for applying to the database) into something legible: farmer and centre
// names instead of ids, and -- for each deferral -- the same alternative-
// slot search the farmer booking screen itself offers on a NO_CAPACITY
// response, computed *after* the plan has been applied so it reflects the
// real post-reallocation state, not a stale one. This is the run's whole
// point as a demo: showing an officer not just who got bumped, but where
// they can actually go next.
async function enrichReallocationPlan(pool, plan, date) {
  const farmerIds = [...plan.deferrals.map((d) => d.farmerId), ...plan.notifications.map((n) => n.farmerId)];
  const noShowBookingIds = plan.noShowReleases.map((r) => r.bookingId);

  const [centresById, farmersById, noShowFarmersByBooking] = await Promise.all([
    loadCentreDisplayNames(pool),
    loadFarmerDisplayNames(pool, farmerIds),
    loadBookingFarmers(pool, noShowBookingIds),
  ]);

  const centreLabel = (centreId) => centresById.get(centreId) || { centreName: null, centreCode: null };

  const centreDayUpserts = plan.centreDayUpserts.map((u) => ({
    centreId: u.centreId,
    ...centreLabel(u.centreId),
    date: u.date,
    totalCapacity: u.engineResult.totalCapacity,
    bookableCapacity: u.engineResult.bookableCapacity,
    bagsCapacity: u.bagsCapacity,
    bindingConstraint: u.engineResult.bindingConstraint,
    bindingConstraints: u.engineResult.bindingConstraints,
  }));

  const noShowReleases = plan.noShowReleases.map((r) => {
    const farmer = noShowFarmersByBooking.get(r.bookingId) || { name: null, phone: null };
    return {
      bookingId: r.bookingId,
      centreId: r.centreId,
      ...centreLabel(r.centreId),
      farmerName: farmer.name,
      bagsReleased: r.bagsReleased,
    };
  });

  const deferrals = await Promise.all(
    plan.deferrals.map(async (d) => {
      const farmer = farmersById.get(d.farmerId) || { name: null, phone: null };
      const alternative = await findAlternatives(pool, { centreId: d.centreId, date: d.date, bagsNeeded: d.bagsReleased });
      return {
        bookingId: d.bookingId,
        farmerId: d.farmerId,
        farmerName: farmer.name,
        farmerPhone: farmer.phone,
        centreId: d.centreId,
        ...centreLabel(d.centreId),
        date: d.date,
        score: d.score,
        bagsReleased: d.bagsReleased,
        reason: d.reason,
        alternative,
      };
    })
  );

  const ewmaUpdates = plan.ewmaUpdates.map((e) => ({
    centreId: e.centreId,
    ...centreLabel(e.centreId),
    newEwmaMinutes: e.newEwmaMinutes,
  }));

  const notifications = plan.notifications.map((n) => {
    const farmer = farmersById.get(n.farmerId) || { name: null, phone: null };
    return {
      farmerId: n.farmerId,
      farmerName: farmer.name,
      relatedBookingId: n.relatedBookingId,
      channel: 'sms',
      body: n.body,
    };
  });

  return { date, centreDayUpserts, noShowReleases, deferrals, ewmaUpdates, notifications };
}

// Recent queued notifications for the messages view -- every channel the
// mock gateway supports (sms/ivr/app), not just what the reallocation job
// itself produces (sms only, today). related_booking_id is only ever set
// by the reallocation job's deferral notices; a plain OTP message has
// none, so it can't be traced to a centre/district -- shown unscoped
// rather than dropped, since there's no farmer-district field to filter
// on either (see CLAUDE.md: single-district demo scope).
async function loadRecentMessages(pool, district, limit = 100) {
  const result = await pool.query(
    `SELECT m.id, m.farmer_id, m.mobile, m.related_booking_id, m.channel, m.body, m.status, m.created_at,
            f.farmer_name, f.phone AS farmer_phone
     FROM messages m
     LEFT JOIN farmers f ON f.id = m.farmer_id
     LEFT JOIN bookings b ON b.id = m.related_booking_id
     LEFT JOIN centre_day cd ON cd.id = b.centre_day_id
     LEFT JOIN centres c ON c.id = cd.centre_id
     WHERE m.related_booking_id IS NULL OR c.district = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [district, limit]
  );
  return result.rows.map((r) => ({
    id: r.id,
    farmerName: r.farmer_name,
    mobile: r.mobile || r.farmer_phone,
    relatedBookingId: r.related_booking_id,
    channel: r.channel,
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
  }));
}

module.exports = { enrichReallocationPlan, loadRecentMessages };
