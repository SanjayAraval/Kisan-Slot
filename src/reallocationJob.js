'use strict';

const crypto = require('crypto');
const { planNightlyReallocation } = require('./reallocationEngine');
const { toEngineInput, loadDailyInputs, upsertCentreDay } = require('./capacityService');
const { haversineKm } = require('./geo');
const { RECOMPUTE_HORIZON_DAYS } = require('./constants');

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadNoShowBookings(client, centreId, date) {
  const centreDay = await client.query('SELECT id FROM centre_day WHERE centre_id = $1 AND service_date = $2', [
    centreId,
    date,
  ]);
  if (!centreDay.rows[0]) return [];

  const noShows = await client.query(
    `SELECT id, bags_reserved FROM bookings
     WHERE centre_day_id = $1 AND status = 'no_show' AND capacity_released_at IS NULL`,
    [centreDay.rows[0].id]
  );
  return noShows.rows.map((r) => ({ bookingId: r.id, bagsReserved: Number(r.bags_reserved) }));
}

async function loadConfirmedBookings(client, centreId, date, centreLat, centreLng) {
  const centreDay = await client.query('SELECT id FROM centre_day WHERE centre_id = $1 AND service_date = $2', [
    centreId,
    date,
  ]);
  if (!centreDay.rows[0]) return [];

  const result = await client.query(
    // A LEFT JOIN to a pre-aggregated deferral count, not a correlated
    // subquery in the SELECT list -- both are valid SQL, but this form
    // is what pg-mem's query planner can actually resolve.
    `SELECT b.id, b.farmer_id, b.bags_reserved, b.booked_at, b.declared_quantity_quintals,
            lr.extent_acres, lr.latitude, lr.longitude,
            COALESCE(pd.prior_deferrals, 0) AS prior_deferrals
     FROM bookings b
     JOIN farmers f ON f.id = b.farmer_id
     JOIN land_records lr ON lr.id = f.land_record_id
     LEFT JOIN (
       SELECT farmer_id, COUNT(*)::int AS prior_deferrals FROM deferrals GROUP BY farmer_id
     ) pd ON pd.farmer_id = b.farmer_id
     WHERE b.centre_day_id = $1 AND b.status = 'booked'`,
    [centreDay.rows[0].id]
  );

  return result.rows.map((r) => ({
    bookingId: r.id,
    farmerId: r.farmer_id,
    bagsReserved: Number(r.bags_reserved),
    bookedAt: r.booked_at,
    extentAcres: Number(r.extent_acres),
    declaredQuantityQuintals: Number(r.declared_quantity_quintals),
    priorDeferrals: r.prior_deferrals,
    // 0 when the land record has no coordinates on file (not every
    // historical record is geocoded) rather than dropping the booking.
    distanceKm:
      r.latitude === null || r.longitude === null || centreLat === null || centreLng === null
        ? 0
        : haversineKm(centreLat, centreLng, Number(r.latitude), Number(r.longitude)),
  }));
}

async function loadCompletedLots(client, centreId, date) {
  const centreDay = await client.query('SELECT id FROM centre_day WHERE centre_id = $1 AND service_date = $2', [
    centreId,
    date,
  ]);
  if (!centreDay.rows[0]) return [];

  const result = await client.query(
    `SELECT checked_in_at, completed_at FROM bookings WHERE centre_day_id = $1 AND status = 'completed'`,
    [centreDay.rows[0].id]
  );
  return result.rows.map((r) => ({ checkedInAt: r.checked_in_at, completedAt: r.completed_at }));
}

async function buildSnapshot(client, today) {
  const centresResult = await client.query('SELECT id, code, latitude, longitude, service_time_ewma_minutes FROM centres');
  const centres = [];

  for (const row of centresResult.rows) {
    const centreId = row.id;
    const centreLat = row.latitude === null ? null : Number(row.latitude);
    const centreLng = row.longitude === null ? null : Number(row.longitude);

    const futureDates = [];
    for (let offset = 1; offset <= RECOMPUTE_HORIZON_DAYS; offset++) {
      const date = addDays(today, offset);
      const dailyInputRow = await loadDailyInputs(client, centreId, date);
      const dailyInputEngineInput = dailyInputRow ? toEngineInput(dailyInputRow) : null;
      const confirmedBookings = dailyInputEngineInput
        ? await loadConfirmedBookings(client, centreId, date, centreLat, centreLng)
        : [];
      futureDates.push({ date, dailyInputEngineInput, confirmedBookings });
    }

    centres.push({
      centreId,
      code: row.code,
      today: { noShowBookings: await loadNoShowBookings(client, centreId, today) },
      futureDates,
      completedLotsToday: await loadCompletedLots(client, centreId, today),
      currentEwmaMinutes: row.service_time_ewma_minutes === null ? null : Number(row.service_time_ewma_minutes),
    });
  }

  return { today, centres };
}

async function applyPlan(client, plan, today) {
  // Bag releases happen *before* the capacity upserts below. centre_day
  // has CHECK (bags_booked <= bags_capacity), evaluated at the end of
  // each statement -- shrinking bags_capacity first, while bags_booked
  // still holds its old (larger) total, would trip that CHECK. Releasing
  // first (against the still-generous old capacity) then tightening
  // capacity afterward never does.
  for (const release of plan.noShowReleases) {
    await client.query('UPDATE bookings SET capacity_released_at = now() WHERE id = $1', [release.bookingId]);
    await client.query(
      `UPDATE centre_day SET bags_booked = GREATEST(0, bags_booked - $1)
       WHERE centre_id = $2 AND service_date = $3`,
      [release.bagsReleased, release.centreId, today]
    );
  }

  for (const deferral of plan.deferrals) {
    await client.query("UPDATE bookings SET status = 'deferred' WHERE id = $1", [deferral.bookingId]);
    await client.query(
      `UPDATE centre_day SET bags_booked = GREATEST(0, bags_booked - $1)
       WHERE centre_id = $2 AND service_date = $3`,
      [deferral.bagsReleased, deferral.centreId, deferral.date]
    );
    await client.query(
      // id generated client-side (see upsertCentreDay's comment) --
      // this insert runs once per deferral with identical query text.
      `INSERT INTO deferrals (id, booking_id, farmer_id, centre_id, original_service_date, score, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), deferral.bookingId, deferral.farmerId, deferral.centreId, deferral.date, deferral.score, deferral.reason]
    );
  }

  for (const notification of plan.notifications) {
    // Every deferral gets both an SMS and its spoken IVR counterpart --
    // CLAUDE.md requires the critical path to work over SMS *and* IVR, so
    // a farmer without a smartphone (or one who can't read the SMS) still
    // gets the news by voice call, not just a text nobody follows up on.
    await client.query(
      `INSERT INTO messages (id, farmer_id, related_booking_id, channel, body)
       VALUES ($1, $2, $3, 'sms', $4)`,
      [crypto.randomUUID(), notification.farmerId, notification.relatedBookingId, notification.body]
    );
    await client.query(
      `INSERT INTO messages (id, farmer_id, related_booking_id, channel, body)
       VALUES ($1, $2, $3, 'ivr', $4)`,
      [crypto.randomUUID(), notification.farmerId, notification.relatedBookingId, notification.voiceScript]
    );
  }

  for (const upsert of plan.centreDayUpserts) {
    await upsertCentreDay(client, upsert.centreId, upsert.date, {
      engineResult: upsert.engineResult,
      bagsCapacity: upsert.bagsCapacity,
    });
  }

  for (const ewma of plan.ewmaUpdates) {
    await client.query('UPDATE centres SET service_time_ewma_minutes = $1 WHERE id = $2', [
      ewma.newEwmaMinutes,
      ewma.centreId,
    ]);
  }
}

// The runner: reads current state into plain data, hands it to the pure
// planNightlyReallocation for every decision, then applies the returned
// plan -- all inside one transaction, so a mid-run failure leaves nothing
// half-applied.
async function runNightlyReallocation(pool, { today } = {}) {
  const runDate = today || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshot = await buildSnapshot(client, runDate);
    const plan = planNightlyReallocation(snapshot);
    await applyPlan(client, plan, runDate);
    await client.query('COMMIT');
    return plan;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runNightlyReallocation, buildSnapshot, applyPlan };
