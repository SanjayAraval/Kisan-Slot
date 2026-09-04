'use strict';

const crypto = require('crypto');
const { MOISTURE_ACCEPT_MAX_PCT, MOISTURE_REJECT_MIN_PCT, KG_PER_BAG } = require('./constants');

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// node-postgres parses a DATE column into a Date built from LOCAL-time
// components (year/month/day), not UTC ones -- toISOString() on it then
// shifts to the previous day in any timezone ahead of UTC (IST included).
// getFullYear/getMonth/getDate read back the same local components pg
// used to build it, so this always agrees with what's actually stored.
function toDateString(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// A "lot" is a booking viewed through its physical-processing lifecycle
// at the centre -- there is no separate lots table. checked_in_at /
// completed_at (on bookings) are the only timestamps that matter for the
// nightly EWMA; every other stage timestamp here is for its own record.

async function checkinLot(client, bookingId, { token }) {
  const result = await client.query('SELECT id, status, token FROM bookings WHERE id = $1', [bookingId]);
  const booking = result.rows[0];
  if (!booking) return { type: 'NOT_FOUND', message: 'booking not found' };
  if (token !== booking.token) return { type: 'BAD_REQUEST', message: 'token does not match this booking' };
  if (booking.status !== 'booked') {
    return { type: 'CONFLICT', message: `booking is '${booking.status}', expected 'booked'` };
  }

  const updated = await client.query(
    "UPDATE bookings SET status = 'checked_in', checked_in_at = now() WHERE id = $1 RETURNING checked_in_at",
    [bookingId]
  );
  return { type: 'OK', bookingId, checkedInAt: updated.rows[0].checked_in_at };
}

async function recordQuality(client, bookingId, { meterId, calibrationDate, samples }) {
  const result = await client.query('SELECT id, status FROM bookings WHERE id = $1', [bookingId]);
  const booking = result.rows[0];
  if (!booking) return { type: 'NOT_FOUND', message: 'booking not found' };
  if (booking.status !== 'checked_in') {
    return { type: 'CONFLICT', message: `booking is '${booking.status}', expected 'checked_in'` };
  }

  const existing = await client.query('SELECT id FROM lot_quality_checks WHERE booking_id = $1', [bookingId]);
  if (existing.rows[0]) return { type: 'CONFLICT', message: 'quality check already recorded for this lot' };

  const mean = round((samples[0] + samples[1] + samples[2]) / 3, 1);
  const verdict = mean <= MOISTURE_ACCEPT_MAX_PCT ? 'accept' : mean > MOISTURE_REJECT_MIN_PCT ? 'reject' : 'cut';

  const inserted = await client.query(
    `INSERT INTO lot_quality_checks (id, booking_id, meter_id, calibration_date, sample_1, sample_2, sample_3, mean_moisture, verdict)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING tested_at`,
    [crypto.randomUUID(), bookingId, meterId, calibrationDate, samples[0], samples[1], samples[2], mean, verdict]
  );

  if (verdict === 'reject') {
    await client.query("UPDATE bookings SET status = 'rejected' WHERE id = $1", [bookingId]);
  }

  return {
    type: 'OK',
    bookingId,
    meterId,
    calibrationDate,
    samples,
    mean,
    verdict,
    testedAt: inserted.rows[0].tested_at,
  };
}

async function recordWeighment(client, bookingId, payload) {
  const result = await client.query(
    `SELECT b.id, b.status, cd.centre_id, cd.service_date
     FROM bookings b
     JOIN centre_day cd ON cd.id = b.centre_day_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = result.rows[0];
  if (!booking) return { type: 'NOT_FOUND', message: 'booking not found' };
  if (booking.status !== 'checked_in') {
    return { type: 'CONFLICT', message: `booking is '${booking.status}', expected 'checked_in'` };
  }

  const quality = await client.query('SELECT verdict FROM lot_quality_checks WHERE booking_id = $1', [bookingId]);
  if (!quality.rows[0]) return { type: 'CONFLICT', message: 'quality check required before weighing' };
  if (quality.rows[0].verdict === 'reject') {
    return { type: 'CONFLICT', message: 'lot was rejected at quality check and cannot be weighed' };
  }

  const existingWeighment = await client.query('SELECT id FROM lot_weighments WHERE booking_id = $1', [bookingId]);
  if (existingWeighment.rows[0]) return { type: 'CONFLICT', message: 'lot already weighed' };

  const serviceDate = toDateString(booking.service_date);
  const dailyInput = await client.query(
    'SELECT weighing_mode FROM centre_daily_inputs WHERE centre_id = $1 AND service_date = $2',
    [booking.centre_id, serviceDate]
  );
  const mode = dailyInput.rows[0] && dailyInput.rows[0].weighing_mode;
  if (!mode) return { type: 'NOT_FOUND', message: 'no operating data for this centre and date' };

  let grossKg = null;
  let tareKg = null;
  let netKg;
  let bagEntries = null;

  if (mode === 'weighbridge') {
    if (typeof payload.grossKg !== 'number' || typeof payload.tareKg !== 'number') {
      return { type: 'BAD_REQUEST', message: 'grossKg and tareKg are required in weighbridge mode' };
    }
    if (payload.tareKg < 0 || payload.grossKg <= payload.tareKg) {
      return { type: 'BAD_REQUEST', message: 'grossKg must be greater than tareKg' };
    }
    grossKg = payload.grossKg;
    tareKg = payload.tareKg;
    netKg = round(grossKg - tareKg, 2);
  } else {
    if (!Array.isArray(payload.bagEntries) || payload.bagEntries.length === 0) {
      return { type: 'BAD_REQUEST', message: 'bagEntries is required in platform mode' };
    }
    for (const entry of payload.bagEntries) {
      if (typeof entry.weightKg !== 'number' || entry.weightKg <= 0) {
        return { type: 'BAD_REQUEST', message: 'each bag entry needs a positive weightKg' };
      }
    }
    bagEntries = payload.bagEntries;
    netKg = round(bagEntries.reduce((sum, e) => sum + e.weightKg, 0), 2);
  }

  const inserted = await client.query(
    `INSERT INTO lot_weighments (id, booking_id, mode, gross_kg, tare_kg, net_kg, bag_entries)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING weighed_at`,
    [crypto.randomUUID(), bookingId, mode, grossKg, tareKg, netKg, bagEntries ? JSON.stringify(bagEntries) : null]
  );

  // Deduct bags used from the centre's actual gunny stock -- distinct
  // from bags_reserved on the booking (a capacity-planning estimate made
  // at booking time from declared quantity). This is the real draw-down.
  const bagsUsed = Math.round(netKg / KG_PER_BAG);
  await client.query(
    // $1 is explicitly cast -- without it, at least one SQL engine this
    // runs against (pg-mem, in tests) fails to infer its type from bare
    // `column - $1` and silently treats it as non-numeric. Harmless and
    // explicit on real Postgres either way.
    `UPDATE centre_daily_inputs SET gunny_bags_available = GREATEST(0, gunny_bags_available - $1::int)
     WHERE centre_id = $2 AND service_date = $3`,
    [bagsUsed, booking.centre_id, serviceDate]
  );

  // completed_at, alongside checked_in_at, is what the nightly job reads
  // to derive today's actual service time for the EWMA -- see
  // reallocationJob.js's loadCompletedLots.
  const updatedBooking = await client.query(
    "UPDATE bookings SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING completed_at",
    [bookingId]
  );

  return {
    type: 'OK',
    bookingId,
    mode,
    grossKg,
    tareKg,
    netKg,
    bagEntries,
    bagsUsed,
    weighedAt: inserted.rows[0].weighed_at,
    completedAt: updatedBooking.rows[0].completed_at,
  };
}

async function issueJForm(client, bookingId, { mspRate, deductions = [] }) {
  const result = await client.query(
    `SELECT b.id, cd.service_date, c.code AS centre_code
     FROM bookings b
     JOIN centre_day cd ON cd.id = b.centre_day_id
     JOIN centres c ON c.id = cd.centre_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = result.rows[0];
  if (!booking) return { type: 'NOT_FOUND', message: 'booking not found' };

  const weighment = await client.query('SELECT net_kg FROM lot_weighments WHERE booking_id = $1', [bookingId]);
  if (!weighment.rows[0]) return { type: 'CONFLICT', message: 'lot must be weighed before a J-Form can be issued' };

  if (typeof mspRate !== 'number' || mspRate <= 0) {
    return { type: 'BAD_REQUEST', message: 'mspRate must be a positive number' };
  }
  for (const d of deductions) {
    if (!d.type || typeof d.amount !== 'number' || d.amount < 0) {
      return { type: 'BAD_REQUEST', message: 'each deduction needs a type and a non-negative amount' };
    }
  }

  const quintalsProcured = round(Number(weighment.rows[0].net_kg) / 100, 2);
  const grossAmount = round(quintalsProcured * mspRate, 2);

  // Correction, not update: the current active J-Form (if any) is
  // superseded, and a brand new row is inserted linking back to it.
  // Nothing about an issued J-Form is ever mutated in place.
  const active = await client.query("SELECT id FROM j_forms WHERE booking_id = $1 AND status = 'active'", [
    bookingId,
  ]);
  const supersedesJFormId = active.rows[0] ? active.rows[0].id : null;
  if (supersedesJFormId) {
    await client.query("UPDATE j_forms SET status = 'superseded' WHERE id = $1", [supersedesJFormId]);
  }

  const priorCount = await client.query('SELECT COUNT(*)::int AS n FROM j_forms WHERE booking_id = $1', [
    bookingId,
  ]);
  const revision = priorCount.rows[0].n + 1;
  const serviceDate = toDateString(booking.service_date);
  const jFormNumber = `${booking.centre_code}-JF-${serviceDate.replace(/-/g, '')}-${String(revision).padStart(4, '0')}`;

  const jFormId = crypto.randomUUID();
  const inserted = await client.query(
    `INSERT INTO j_forms (id, booking_id, j_form_number, quintals_procured, msp_rate, gross_amount, supersedes_j_form_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING issued_at`,
    [jFormId, bookingId, jFormNumber, quintalsProcured, mspRate, grossAmount, supersedesJFormId]
  );

  let totalDeductions = 0;
  for (const d of deductions) {
    totalDeductions += d.amount;
    await client.query(
      `INSERT INTO payment_deductions (id, j_form_id, deduction_type, amount, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), jFormId, d.type, d.amount, d.description || null]
    );
  }

  return {
    type: 'OK',
    jFormId,
    jFormNumber,
    quintalsProcured,
    mspRate,
    grossAmount,
    deductions,
    totalDeductions: round(totalDeductions, 2),
    netPayable: round(grossAmount - totalDeductions, 2),
    supersedesJFormId,
    issuedAt: inserted.rows[0].issued_at,
  };
}

async function recordDispatch(client, bookingId, { vehicleNumber }) {
  const result = await client.query('SELECT id FROM bookings WHERE id = $1', [bookingId]);
  if (!result.rows[0]) return { type: 'NOT_FOUND', message: 'booking not found' };

  if (!vehicleNumber || typeof vehicleNumber !== 'string') {
    return { type: 'BAD_REQUEST', message: 'vehicleNumber is required' };
  }

  const activeJForm = await client.query("SELECT id FROM j_forms WHERE booking_id = $1 AND status = 'active'", [
    bookingId,
  ]);
  if (!activeJForm.rows[0]) return { type: 'CONFLICT', message: 'J-Form must be issued before dispatch' };

  const dispatched = await client.query(
    `INSERT INTO dispatches (id, booking_id, vehicle_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (booking_id) DO UPDATE SET vehicle_number = EXCLUDED.vehicle_number, dispatched_at = now()
     RETURNING dispatched_at`,
    [crypto.randomUUID(), bookingId, vehicleNumber]
  );

  return { type: 'OK', bookingId, vehicleNumber, dispatchedAt: dispatched.rows[0].dispatched_at };
}

module.exports = { checkinLot, recordQuality, recordWeighment, issueJForm, recordDispatch };
