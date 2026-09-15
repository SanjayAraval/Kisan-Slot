'use strict';

const crypto = require('crypto');
const { YIELD_QUINTALS_PER_ACRE, BAGS_PER_QUINTAL, OVER_DECLARE_CAP_MULTIPLIER, NEARBY_CENTRE_RADIUS_KM, ALT_DATE_SEARCH_HORIZON_DAYS } = require('./constants');
const { computeCentreDayCapacity, upsertCentreDay } = require('./capacityService');
const { haversineKm } = require('./geo');

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function bagsToSlots(bags, bagsPerTruck) {
  return Math.floor(bags / bagsPerTruck);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadFarmerWithLandRecord(client, farmerId) {
  const result = await client.query(
    `SELECT f.id, f.farmer_name, f.land_record_id, lr.extent_acres
     FROM farmers f
     LEFT JOIN land_records lr ON lr.id = f.land_record_id
     WHERE f.id = $1`,
    [farmerId]
  );
  return result.rows[0] || null;
}

// The bookings table's own unique constraint only stops a *second* booking
// at the same centre-day (see its schema comment) -- a farmer could still
// book two different centres for the same date. This is the check that
// actually enforces "one active booking per farmer per date", checked
// before any capacity is touched.
async function hasActiveBookingOnDate(client, farmerId, date) {
  const result = await client.query(
    `SELECT b.id FROM bookings b
     JOIN centre_day cd ON cd.id = b.centre_day_id
     WHERE b.farmer_id = $1 AND cd.service_date = $2 AND b.status IN ('booked', 'checked_in')
     LIMIT 1`,
    [farmerId, date]
  );
  return result.rowCount > 0;
}

// Runs steps 1-5 of the booking flow inside the caller's transaction.
// The caller (the route) decides whether to COMMIT (BOOKED) or ROLLBACK
// (everything else) based on the returned `type`.
async function attemptBooking(client, { farmerId, quintals, centreId, date }) {
  const farmer = await loadFarmerWithLandRecord(client, farmerId);
  if (!farmer) {
    return { type: 'NOT_FOUND', message: 'farmer not found' };
  }

  if (await hasActiveBookingOnDate(client, farmerId, date)) {
    return {
      type: 'ALREADY_BOOKED',
      message: 'This farmer already has an active booking for this date.',
    };
  }

  // Step 1: no land record at all -- flag for a human, don't reject.
  if (!farmer.land_record_id) {
    return {
      type: 'NEEDS_OFFICER_REVIEW',
      reason: 'no_land_record',
      message: 'Farmer has no matching land record. An officer must verify before booking.',
    };
  }

  // Step 2: declared quantity wildly out of line with the land record --
  // also flagged, not rejected.
  const landEstimateQuintals = round(Number(farmer.extent_acres) * YIELD_QUINTALS_PER_ACRE, 2);
  const cap = round(OVER_DECLARE_CAP_MULTIPLIER * landEstimateQuintals, 2);
  if (quintals > cap) {
    return {
      type: 'NEEDS_OFFICER_REVIEW',
      reason: 'quantity_exceeds_estimate',
      message: `Declared ${quintals}q exceeds ${OVER_DECLARE_CAP_MULTIPLIER}x the land-record estimate of ${landEstimateQuintals}q.`,
      landEstimateQuintals,
      requestedQuintals: quintals,
    };
  }

  // Step 3: today's authoritative capacity, computed live.
  const capacity = await computeCentreDayCapacity(client, centreId, date);
  if (!capacity) {
    return { type: 'NOT_FOUND', message: 'centre has no operating data for this date' };
  }
  const centreDayRow = await upsertCentreDay(client, centreId, date, capacity);
  const bagsNeeded = round(quintals * BAGS_PER_QUINTAL, 2);

  // Step 4: atomically claim the bags. This single guarded UPDATE is the
  // entire concurrency-safety mechanism -- see the schema comment on
  // centre_day. No SELECT-then-INSERT race window exists here.
  const claim = await client.query(
    `UPDATE centre_day
     SET bags_booked = bags_booked + $1
     WHERE id = $2 AND bags_booked + $1 <= bags_capacity
     RETURNING bags_booked, bags_capacity`,
    [bagsNeeded, centreDayRow.id]
  );

  if (claim.rowCount === 0) {
    return {
      type: 'NO_CAPACITY',
      centreId,
      date,
      bagsNeeded,
      bagsPerTruck: capacity.bagsPerTruck,
      message: 'Requested quantity does not fit in remaining capacity for this centre and date.',
    };
  }

  // Step 5: create the booking and a token.
  const centreResult = await client.query('SELECT code FROM centres WHERE id = $1', [centreId]);
  const centreCode = centreResult.rows[0].code;
  const countResult = await client.query('SELECT COUNT(*)::int AS n FROM bookings WHERE centre_day_id = $1', [
    centreDayRow.id,
  ]);
  const sequence = countResult.rows[0].n + 1;
  const token = `${centreCode}-${date.replace(/-/g, '')}-${String(sequence).padStart(4, '0')}`;

  let bookingResult;
  try {
    bookingResult = await client.query(
      // id generated client-side rather than left to the column's DEFAULT
      // gen_random_uuid() -- consistent with upsertCentreDay (see its
      // comment): this exact query text can run many times per process.
      `INSERT INTO bookings (id, centre_day_id, farmer_id, token, declared_quantity_quintals, bags_reserved, booking_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, token, booked_at`,
      [crypto.randomUUID(), centreDayRow.id, farmerId, token, quintals, bagsNeeded, 'app']
    );
  } catch (err) {
    // 23505 = unique_violation. The only realistic cause on this INSERT is
    // (centre_day_id, farmer_id) -- one active booking per farmer per
    // centre-day (see the schema comment); a token collision would need
    // two bookings to race to the same sequence number, which the COUNT
    // above makes vanishingly unlikely. The caller rolls back the
    // transaction for any non-BOOKED result, which also undoes the bag
    // claim above.
    if (err.code === '23505') {
      return {
        type: 'ALREADY_BOOKED',
        message: 'This farmer already has a booking for this centre and date.',
      };
    }
    throw err;
  }

  const { bags_booked: bagsBooked, bags_capacity: bagsCapacity } = claim.rows[0];
  const remainingBags = Number(bagsCapacity) - Number(bagsBooked);

  return {
    type: 'BOOKED',
    booking: {
      id: bookingResult.rows[0].id,
      token: bookingResult.rows[0].token,
      farmerId,
      centreId,
      date,
      quintals,
      bagsReserved: bagsNeeded,
      bookedAt: bookingResult.rows[0].booked_at,
    },
    remainingBags,
    remainingSlots: bagsToSlots(remainingBags, capacity.bagsPerTruck),
  };
}

// Read-only lookups run *after* the reservation transaction has rolled
// back -- no lock held, nothing reserved by looking.
async function existingBagsBooked(pool, centreId, date) {
  const result = await pool.query('SELECT bags_booked FROM centre_day WHERE centre_id = $1 AND service_date = $2', [
    centreId,
    date,
  ]);
  return result.rows[0] ? Number(result.rows[0].bags_booked) : 0;
}

async function findNextAvailableDate(pool, { centreId, afterDate, bagsNeeded }) {
  for (let offset = 1; offset <= ALT_DATE_SEARCH_HORIZON_DAYS; offset++) {
    const candidateDate = addDays(afterDate, offset);
    const capacity = await computeCentreDayCapacity(pool, centreId, candidateDate);
    if (!capacity) continue;

    const booked = await existingBagsBooked(pool, centreId, candidateDate);
    const remainingBags = capacity.bagsCapacity - booked;
    if (remainingBags >= bagsNeeded) {
      return {
        date: candidateDate,
        remainingBags: round(remainingBags, 2),
        remainingSlots: bagsToSlots(remainingBags, capacity.bagsPerTruck),
      };
    }
  }
  return null;
}

async function findNearbyCentresWithRoom(pool, { centreId, date, bagsNeeded }) {
  const originResult = await pool.query('SELECT latitude, longitude FROM centres WHERE id = $1', [centreId]);
  const origin = originResult.rows[0];
  if (!origin) return [];

  const othersResult = await pool.query('SELECT id, name, code, latitude, longitude FROM centres WHERE id != $1', [
    centreId,
  ]);

  const candidates = [];
  for (const other of othersResult.rows) {
    const distanceKm = haversineKm(Number(origin.latitude), Number(origin.longitude), Number(other.latitude), Number(other.longitude));
    if (distanceKm > NEARBY_CENTRE_RADIUS_KM) continue;

    const capacity = await computeCentreDayCapacity(pool, other.id, date);
    if (!capacity) continue;

    const booked = await existingBagsBooked(pool, other.id, date);
    const remainingBags = capacity.bagsCapacity - booked;
    if (remainingBags < bagsNeeded) continue;

    candidates.push({
      centreId: other.id,
      name: other.name,
      code: other.code,
      distanceKm: round(distanceKm, 1),
      remainingBags: round(remainingBags, 2),
      remainingSlots: bagsToSlots(remainingBags, capacity.bagsPerTruck),
    });
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates;
}

async function findAlternatives(pool, { centreId, date, bagsNeeded }) {
  const [nextDateAtThisCentre, nearbyCentres] = await Promise.all([
    findNextAvailableDate(pool, { centreId, afterDate: date, bagsNeeded }),
    findNearbyCentresWithRoom(pool, { centreId, date, bagsNeeded }),
  ]);
  return { nextDateAtThisCentre, nearbyCentres };
}

module.exports = { attemptBooking, findAlternatives, bagsToSlots };
