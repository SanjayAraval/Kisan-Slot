'use strict';

const crypto = require('crypto');
const { computeDailyCapacity } = require('./capacityEngine');

// Maps a centre_daily_inputs row (pg's snake_case, numeric columns as
// strings) to the capacity engine's expected camelCase numeric input.
// yardCapacityTonnes is the *effective* space -- total minus whatever's
// already sitting there undispatched -- never the yard's nameplate size.
function toEngineInput(row) {
  return {
    weighingMode: row.weighing_mode,
    weighbridgeOperatingMinutes: Number(row.weighbridge_operating_minutes),
    weighbridgeAvgCycleMinutes:
      row.weighbridge_avg_cycle_minutes === null ? undefined : Number(row.weighbridge_avg_cycle_minutes),
    secondsPerBag: row.seconds_per_bag === null ? undefined : Number(row.seconds_per_bag),
    avgBagsPerLot: row.avg_bags_per_lot === null ? undefined : Number(row.avg_bags_per_lot),
    hamaliGangCount: Number(row.hamali_gang_count),
    hamaliBagsPerGangPerDay: Number(row.hamali_bags_per_gang_per_day),
    bagsPerTruck: Number(row.bags_per_truck),
    gunnyBagsAvailable: Number(row.gunny_bags_available),
    truckEvacuationCapacity: Number(row.truck_evacuation_capacity),
    yardCapacityTonnes: Number(row.yard_capacity_tonnes) - Number(row.undispatched_tonnes),
    avgTruckLoadTonnes: Number(row.avg_truck_load_tonnes),
    moistureMeterCount: Number(row.moisture_meter_count),
    moistureTestsPerMeterPerDay: Number(row.moisture_tests_per_meter_per_day),
  };
}

async function loadDailyInputs(client, centreId, serviceDate) {
  const result = await client.query(
    'SELECT * FROM centre_daily_inputs WHERE centre_id = $1 AND service_date = $2',
    [centreId, serviceDate]
  );
  return result.rows[0] || null;
}

// Raw stored values, camelCased, for round-tripping through an API --
// unlike toEngineInput, yardCapacityTonnes here is the nameplate size,
// not (size - undispatched); the caller gets both fields back as-stored.
function toApiInputs(row) {
  return {
    weighingMode: row.weighing_mode,
    weighbridgeOperatingMinutes: Number(row.weighbridge_operating_minutes),
    weighbridgeAvgCycleMinutes: row.weighbridge_avg_cycle_minutes === null ? null : Number(row.weighbridge_avg_cycle_minutes),
    secondsPerBag: row.seconds_per_bag === null ? null : Number(row.seconds_per_bag),
    avgBagsPerLot: row.avg_bags_per_lot === null ? null : Number(row.avg_bags_per_lot),
    hamaliGangCount: Number(row.hamali_gang_count),
    hamaliBagsPerGangPerDay: Number(row.hamali_bags_per_gang_per_day),
    bagsPerTruck: Number(row.bags_per_truck),
    gunnyBagsAvailable: Number(row.gunny_bags_available),
    truckEvacuationCapacity: Number(row.truck_evacuation_capacity),
    yardCapacityTonnes: Number(row.yard_capacity_tonnes),
    undispatchedTonnes: Number(row.undispatched_tonnes),
    avgTruckLoadTonnes: Number(row.avg_truck_load_tonnes),
    moistureMeterCount: Number(row.moisture_meter_count),
    moistureTestsPerMeterPerDay: Number(row.moisture_tests_per_meter_per_day),
    // Echoed straight back on the next submit as expectedUpdatedAt --
    // lets the server detect a stale resubmit (see upsertDailyInputs).
    updatedAt: row.updated_at,
  };
}

// Upserts the night's declared operating inputs for a centre/date -- a
// genuine correction (the officer can re-declare before the night is
// out), not append-only like a J-Form. id is generated client-side; see
// upsertCentreDay's comment for why.
//
// `expectedUpdatedAt`, when given, guards against a stale resubmit: if a
// declaration already on file has since been touched by someone else
// (most concretely, bags released from the district dashboard) the
// officer's now-outdated form must not silently overwrite it. Checked
// with a plain conditional UPDATE first (not an ON CONFLICT ... WHERE
// upsert) so "the WHERE didn't match" and "no row existed yet" are two
// unambiguous, separately-handled outcomes rather than relying on
// RETURNING-on-a-blocked-conflict semantics.
async function upsertDailyInputs(client, centreId, serviceDate, inputs, expectedUpdatedAt) {
  // Generated here in JS, not via SQL now(), and reused for both branches
  // below -- node-postgres round-trips a JS Date at millisecond precision,
  // matching exactly what a client gets back from JSON (Date#toJSON is
  // also millisecond-precision). SQL now() is microsecond-precision, so
  // stamping with it here and later comparing against a client-echoed,
  // JSON-truncated value would make updated_at = $3 below fail on every
  // resubmit -- not just a genuine concurrent edit.
  const now = new Date();
  if (expectedUpdatedAt) {
    const updateResult = await client.query(
      `UPDATE centre_daily_inputs SET
         weighing_mode = $4, weighbridge_operating_minutes = $5, weighbridge_avg_cycle_minutes = $6,
         seconds_per_bag = $7, avg_bags_per_lot = $8, hamali_gang_count = $9, hamali_bags_per_gang_per_day = $10,
         bags_per_truck = $11, gunny_bags_available = $12, truck_evacuation_capacity = $13,
         yard_capacity_tonnes = $14, undispatched_tonnes = $15, avg_truck_load_tonnes = $16,
         moisture_meter_count = $17, moisture_tests_per_meter_per_day = $18, updated_at = $19
       WHERE centre_id = $1 AND service_date = $2 AND updated_at = $3
       RETURNING id, updated_at`,
      [
        centreId, serviceDate, expectedUpdatedAt, inputs.weighingMode,
        inputs.weighbridgeOperatingMinutes, inputs.weighbridgeAvgCycleMinutes, inputs.secondsPerBag, inputs.avgBagsPerLot,
        inputs.hamaliGangCount, inputs.hamaliBagsPerGangPerDay, inputs.bagsPerTruck, inputs.gunnyBagsAvailable,
        inputs.truckEvacuationCapacity, inputs.yardCapacityTonnes, inputs.undispatchedTonnes, inputs.avgTruckLoadTonnes,
        inputs.moistureMeterCount, inputs.moistureTestsPerMeterPerDay, now,
      ]
    );
    if (updateResult.rowCount > 0) {
      return { id: updateResult.rows[0].id, updatedAt: updateResult.rows[0].updated_at, stale: false };
    }

    const existing = await client.query(
      'SELECT id FROM centre_daily_inputs WHERE centre_id = $1 AND service_date = $2',
      [centreId, serviceDate]
    );
    if (existing.rows[0]) {
      // A row exists but its updated_at didn't match -- someone else
      // changed it since the caller last loaded it.
      return { stale: true };
    }
    // No row yet at all -- expectedUpdatedAt is meaningless for a first
    // declaration; fall through to the plain insert below.
  }

  const result = await client.query(
    `INSERT INTO centre_daily_inputs (
       id, centre_id, service_date, weighing_mode,
       weighbridge_operating_minutes, weighbridge_avg_cycle_minutes, seconds_per_bag, avg_bags_per_lot,
       hamali_gang_count, hamali_bags_per_gang_per_day, bags_per_truck, gunny_bags_available,
       truck_evacuation_capacity, yard_capacity_tonnes, undispatched_tonnes, avg_truck_load_tonnes,
       moisture_meter_count, moisture_tests_per_meter_per_day, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (centre_id, service_date) DO UPDATE SET
       weighing_mode = EXCLUDED.weighing_mode,
       weighbridge_operating_minutes = EXCLUDED.weighbridge_operating_minutes,
       weighbridge_avg_cycle_minutes = EXCLUDED.weighbridge_avg_cycle_minutes,
       seconds_per_bag = EXCLUDED.seconds_per_bag,
       avg_bags_per_lot = EXCLUDED.avg_bags_per_lot,
       hamali_gang_count = EXCLUDED.hamali_gang_count,
       hamali_bags_per_gang_per_day = EXCLUDED.hamali_bags_per_gang_per_day,
       bags_per_truck = EXCLUDED.bags_per_truck,
       gunny_bags_available = EXCLUDED.gunny_bags_available,
       truck_evacuation_capacity = EXCLUDED.truck_evacuation_capacity,
       yard_capacity_tonnes = EXCLUDED.yard_capacity_tonnes,
       undispatched_tonnes = EXCLUDED.undispatched_tonnes,
       avg_truck_load_tonnes = EXCLUDED.avg_truck_load_tonnes,
       moisture_meter_count = EXCLUDED.moisture_meter_count,
       moisture_tests_per_meter_per_day = EXCLUDED.moisture_tests_per_meter_per_day,
       updated_at = EXCLUDED.updated_at
     RETURNING id, updated_at`,
    [
      crypto.randomUUID(), centreId, serviceDate, inputs.weighingMode,
      inputs.weighbridgeOperatingMinutes, inputs.weighbridgeAvgCycleMinutes, inputs.secondsPerBag, inputs.avgBagsPerLot,
      inputs.hamaliGangCount, inputs.hamaliBagsPerGangPerDay, inputs.bagsPerTruck, inputs.gunnyBagsAvailable,
      inputs.truckEvacuationCapacity, inputs.yardCapacityTonnes, inputs.undispatchedTonnes, inputs.avgTruckLoadTonnes,
      inputs.moistureMeterCount, inputs.moistureTestsPerMeterPerDay, now,
    ]
  );
  return { id: result.rows[0].id, updatedAt: result.rows[0].updated_at, stale: false };
}

// Computes today's authoritative capacity straight from
// centre_daily_inputs via the real capacity engine -- never trusts a
// possibly-stale centre_day snapshot for this. Returns null if the centre
// has no operating data for that date at all.
async function computeCentreDayCapacity(client, centreId, serviceDate) {
  const dailyInputRow = await loadDailyInputs(client, centreId, serviceDate);
  if (!dailyInputRow) return null;

  const engineResult = computeDailyCapacity(toEngineInput(dailyInputRow));
  const bagsPerTruck = Number(dailyInputRow.bags_per_truck);
  const bagsCapacity = engineResult.bookableCapacity * bagsPerTruck;

  return { dailyInputRow, engineResult, bagsPerTruck, bagsCapacity };
}

// Bookable slots left right now for one centre/date, net of what's
// already booked -- the same "remaining" a farmer would be quoted on
// /centres/:id/availability, factored out so the farmer-facing centre
// list (GET /centres?date=) can filter out centres with nothing left
// without duplicating the bags-booked arithmetic. Returns null when the
// centre has no declaration on file for that date at all (never 0 --
// 0 means declared-but-full, a different situation from never declared).
async function computeRemainingSlots(client, centreId, serviceDate) {
  const capacity = await computeCentreDayCapacity(client, centreId, serviceDate);
  if (!capacity) return null;

  const existing = await client.query(
    'SELECT bags_booked FROM centre_day WHERE centre_id = $1 AND service_date = $2',
    [centreId, serviceDate]
  );
  const bagsBooked = existing.rows[0] ? Number(existing.rows[0].bags_booked) : 0;
  const remainingBags = capacity.bagsCapacity - bagsBooked;
  const remaining = Math.max(0, Math.floor(remainingBags / capacity.bagsPerTruck));

  return {
    totalCapacity: capacity.engineResult.totalCapacity,
    bookableCapacity: capacity.engineResult.bookableCapacity,
    remaining,
  };
}

// Upserts the centre_day snapshot row so bookings have something to
// reference, without ever resetting bags_booked -- that ledger only ever
// moves via the guarded UPDATE in bookingService.
async function upsertCentreDay(client, centreId, serviceDate, capacity) {
  const { engineResult, bagsCapacity } = capacity;
  // id is generated here rather than left to the column's own
  // DEFAULT gen_random_uuid() -- purely an INSERT-branch value (the
  // ON CONFLICT branch below never touches id, so an existing row keeps
  // its own). Matches how the rest of the codebase generates ids.
  const result = await client.query(
    `INSERT INTO centre_day (
       id, centre_id, service_date, total_capacity, walk_in_reserved, bookable_capacity,
       bags_capacity, binding_constraint, constraint_breakdown
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (centre_id, service_date) DO UPDATE SET
       total_capacity = EXCLUDED.total_capacity,
       walk_in_reserved = EXCLUDED.walk_in_reserved,
       bookable_capacity = EXCLUDED.bookable_capacity,
       bags_capacity = EXCLUDED.bags_capacity,
       binding_constraint = EXCLUDED.binding_constraint,
       constraint_breakdown = EXCLUDED.constraint_breakdown
     RETURNING id, bags_capacity, bags_booked`,
    [
      crypto.randomUUID(),
      centreId,
      serviceDate,
      engineResult.totalCapacity,
      engineResult.walkInReserved,
      engineResult.bookableCapacity,
      bagsCapacity,
      engineResult.bindingConstraint,
      JSON.stringify(engineResult.constraints),
    ]
  );
  return result.rows[0];
}

module.exports = {
  toEngineInput,
  toApiInputs,
  loadDailyInputs,
  computeCentreDayCapacity,
  computeRemainingSlots,
  upsertCentreDay,
  upsertDailyInputs,
};
