'use strict';

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

// Upserts the centre_day snapshot row so bookings have something to
// reference, without ever resetting bags_booked -- that ledger only ever
// moves via the guarded UPDATE in bookingService.
async function upsertCentreDay(client, centreId, serviceDate, capacity) {
  const { engineResult, bagsCapacity } = capacity;
  const result = await client.query(
    `INSERT INTO centre_day (
       centre_id, service_date, total_capacity, walk_in_reserved, bookable_capacity,
       bags_capacity, binding_constraint, constraint_breakdown
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (centre_id, service_date) DO UPDATE SET
       total_capacity = EXCLUDED.total_capacity,
       walk_in_reserved = EXCLUDED.walk_in_reserved,
       bookable_capacity = EXCLUDED.bookable_capacity,
       bags_capacity = EXCLUDED.bags_capacity,
       binding_constraint = EXCLUDED.binding_constraint,
       constraint_breakdown = EXCLUDED.constraint_breakdown
     RETURNING id, bags_capacity, bags_booked`,
    [
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

module.exports = { toEngineInput, loadDailyInputs, computeCentreDayCapacity, upsertCentreDay };
