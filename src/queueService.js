'use strict';

const { checkinLot } = require('./lotService');
const { MOISTURE_ACCEPT_MAX_PCT } = require('./constants');

// node-postgres parses a DATE column into a Date built from LOCAL-time
// components -- see lotService.js's own copy of this for why
// toISOString() would be wrong here.
function toDateString(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The gate scan: same validation and status transition as the existing
// checkinLot (token must match, booking must be 'booked') -- "scan" is
// just that action under the name and framing the live queue screen
// uses, plus the centre/date the caller needs to know which queue this
// lot just joined (for the WebSocket broadcast).
//
// Checked before any of that: the booking's service date against
// `today`. The live queue only ever lists today's centre_day (see
// loadQueue), so a pass scanned early or late would check the lot in
// yet never appear anywhere -- "Checked in" at the gate, "Nobody in the
// queue yet" on screen. Rejected here, before checkinLot runs, so a
// mis-dated scan never mutates booking status at all.
async function scanLot(client, bookingId, token, today) {
  const dateResult = await client.query(
    `SELECT cd.centre_id, cd.service_date FROM bookings b
     JOIN centre_day cd ON cd.id = b.centre_day_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const dateRow = dateResult.rows[0];
  if (!dateRow) return { type: 'NOT_FOUND', message: 'booking not found' };

  const serviceDate = toDateString(dateRow.service_date);
  if (serviceDate !== today) {
    const message =
      serviceDate > today
        ? `This gate pass is valid for ${serviceDate}, not today.`
        : `This gate pass was valid for ${serviceDate} and has expired.`;
    return { type: 'BAD_REQUEST', message };
  }

  const result = await checkinLot(client, bookingId, { token });
  if (result.type !== 'OK') return result;

  return { ...result, centreId: dateRow.centre_id, serviceDate };
}

// Resolves a scanned/typed token to the booking it belongs to -- the
// manual-entry fallback (and a QR whose payload is somehow just the
// token) only has the token, not the booking's internal id that every
// other /lots/:id/* action is keyed on. Read-only and not centre-scoped
// (the centre isn't known until after this lookup) -- the follow-up
// POST .../scan re-validates centre scope for real before anything
// mutates.
async function lookupByToken(pool, token) {
  const result = await pool.query(
    `SELECT b.id, b.token, b.status, f.farmer_name, cd.centre_id, cd.service_date, c.name AS centre_name, c.code AS centre_code
     FROM bookings b
     JOIN farmers f ON f.id = b.farmer_id
     JOIN centre_day cd ON cd.id = b.centre_day_id
     JOIN centres c ON c.id = cd.centre_id
     WHERE b.token = $1`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    bookingId: row.id,
    token: row.token,
    status: row.status,
    farmerName: row.farmer_name,
    centreId: row.centre_id,
    centreName: row.centre_name,
    centreCode: row.centre_code,
    serviceDate: toDateString(row.service_date),
  };
}

// Advances the queue: the lot has been called forward and is no longer
// waiting. Deliberately independent of the full processing pipeline
// (quality check, weighment, ...) further down -- see the migration's
// comment on queue_served_at -- so this never touches bookings.status.
async function markServed(client, bookingId) {
  const result = await client.query(
    `SELECT b.id, b.status, b.queue_served_at, cd.centre_id, cd.service_date
     FROM bookings b JOIN centre_day cd ON cd.id = b.centre_day_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = result.rows[0];
  if (!booking) return { type: 'NOT_FOUND', message: 'booking not found' };
  if (booking.status !== 'checked_in') {
    return { type: 'CONFLICT', message: `booking is '${booking.status}', expected 'checked_in'` };
  }
  if (booking.queue_served_at !== null) {
    return { type: 'CONFLICT', message: 'lot has already left the queue' };
  }

  const updated = await client.query(
    'UPDATE bookings SET queue_served_at = now() WHERE id = $1 RETURNING queue_served_at',
    [bookingId]
  );
  return {
    type: 'OK',
    bookingId,
    centreId: booking.centre_id,
    serviceDate: toDateString(booking.service_date),
    queueServedAt: updated.rows[0].queue_served_at,
  };
}

// The live queue for one centre/date: who's now serving, who's waiting
// and in what order, and each waiting lot's predicted ETA -- position
// (how many lots ahead of it, including now-serving) times the centre's
// own observed service-time EWMA (see reallocationEngine's
// updateEwma/averageServiceMinutes), never a fixed guess. null, not a
// fabricated number, when the centre has no observed EWMA yet -- same
// "no data, not zero" rule the dashboard's gunny-cover figure follows.
// Returns null only when the centre itself doesn't exist; a centre with
// no operating data for `date` at all still gets a real (empty) queue,
// since the queue is about who has physically checked in, not about
// declared capacity.
async function loadQueue(pool, centreId, date) {
  const centreResult = await pool.query(
    'SELECT id, name, code, service_time_ewma_minutes FROM centres WHERE id = $1',
    [centreId]
  );
  const centre = centreResult.rows[0];
  if (!centre) return null;

  const ewmaMinutes = centre.service_time_ewma_minutes === null ? null : Number(centre.service_time_ewma_minutes);
  const base = {
    centreId: centre.id,
    centreName: centre.name,
    centreCode: centre.code,
    date,
    averageWaitMinutes: ewmaMinutes,
    moistureLimitPct: MOISTURE_ACCEPT_MAX_PCT,
  };

  const centreDayResult = await pool.query('SELECT id FROM centre_day WHERE centre_id = $1 AND service_date = $2', [
    centreId,
    date,
  ]);
  const centreDay = centreDayResult.rows[0];
  if (!centreDay) {
    return { ...base, nowServing: null, waiting: [], servedCount: 0 };
  }

  const [queueResult, servedResult] = await Promise.all([
    pool.query(
      `SELECT b.id, b.token, b.checked_in_at, f.farmer_name
       FROM bookings b JOIN farmers f ON f.id = b.farmer_id
       WHERE b.centre_day_id = $1 AND b.status = 'checked_in' AND b.queue_served_at IS NULL
       ORDER BY b.checked_in_at ASC`,
      [centreDay.id]
    ),
    pool.query('SELECT COUNT(*)::int AS n FROM bookings WHERE centre_day_id = $1 AND queue_served_at IS NOT NULL', [
      centreDay.id,
    ]),
  ]);

  const rows = queueResult.rows;
  const nowServing = rows[0]
    ? { bookingId: rows[0].id, token: rows[0].token, farmerName: rows[0].farmer_name, checkedInAt: rows[0].checked_in_at }
    : null;

  const waiting = rows.slice(1).map((r, i) => {
    const position = i + 1; // 1 = next up after now-serving
    return {
      bookingId: r.id,
      token: r.token,
      farmerName: r.farmer_name,
      checkedInAt: r.checked_in_at,
      position,
      etaMinutes: ewmaMinutes === null ? null : Math.round(position * ewmaMinutes),
    };
  });

  return { ...base, nowServing, waiting, servedCount: servedResult.rows[0].n };
}

module.exports = { scanLot, lookupByToken, markServed, loadQueue };
