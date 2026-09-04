'use strict';

const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

async function insertCentre(pool, overrides = {}) {
  const id = overrides.id || uuid();
  await pool.query(
    `INSERT INTO centres (id, name, code, centre_type, district, state, latitude, longitude)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      overrides.name || 'Test Centre',
      overrides.code || `TEST-${id.slice(0, 8)}`,
      overrides.centreType || 'apmc_mandi',
      overrides.district || 'Medak',
      overrides.state || 'Telangana',
      overrides.lat ?? 18.0,
      overrides.lng ?? 78.0,
    ]
  );
  return id;
}

const DAILY_INPUT_BASELINE = {
  weighingMode: 'weighbridge',
  weighbridgeOperatingMinutes: 480,
  weighbridgeAvgCycleMinutes: 8, // 480/8 = 60
  secondsPerBag: null,
  avgBagsPerLot: null,
  hamaliGangCount: 10,
  hamaliBagsPerGangPerDay: 600, // 10*600/100 = 60
  bagsPerTruck: 100,
  gunnyBagsAvailable: 6000, // 6000/100 = 60
  truckEvacuationCapacity: 60,
  yardCapacityTonnes: 600,
  undispatchedTonnes: 0, // (600-0)/10 = 60
  avgTruckLoadTonnes: 10,
  moistureMeterCount: 5,
  moistureTestsPerMeterPerDay: 100, // 500 -- never binds
};

// Every constraint defaults to a capacity of 60/day (ample) so a test can
// override just the one field it cares about without the others
// interfering.
async function insertDailyInputs(pool, { centreId, serviceDate, overrides = {} }) {
  const row = { ...DAILY_INPUT_BASELINE, ...overrides };
  const id = uuid();
  await pool.query(
    `INSERT INTO centre_daily_inputs (
       id, centre_id, service_date, weighing_mode,
       weighbridge_operating_minutes, weighbridge_avg_cycle_minutes, seconds_per_bag, avg_bags_per_lot,
       hamali_gang_count, hamali_bags_per_gang_per_day, bags_per_truck, gunny_bags_available,
       truck_evacuation_capacity, yard_capacity_tonnes, undispatched_tonnes, avg_truck_load_tonnes,
       moisture_meter_count, moisture_tests_per_meter_per_day
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id, centreId, serviceDate, row.weighingMode,
      row.weighbridgeOperatingMinutes, row.weighbridgeAvgCycleMinutes, row.secondsPerBag, row.avgBagsPerLot,
      row.hamaliGangCount, row.hamaliBagsPerGangPerDay, row.bagsPerTruck, row.gunnyBagsAvailable,
      row.truckEvacuationCapacity, row.yardCapacityTonnes, row.undispatchedTonnes, row.avgTruckLoadTonnes,
      row.moistureMeterCount, row.moistureTestsPerMeterPerDay,
    ]
  );
  return id;
}

async function insertLandRecord(pool, overrides = {}) {
  const id = overrides.id || uuid();
  await pool.query(
    `INSERT INTO land_records (id, land_record_number, farmer_name, father_name, village, survey_number, extent_acres, crop)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      overrides.landRecordNumber || `TEST-LR-${id.slice(0, 8)}`,
      overrides.farmerName || 'Test Owner',
      overrides.fatherName || 'Test Father',
      overrides.village || 'Test Village',
      overrides.surveyNumber || '1/A',
      overrides.extentAcres ?? 2.5,
      overrides.crop || 'Paddy',
    ]
  );
  return id;
}

async function insertFarmer(pool, overrides = {}) {
  const id = overrides.id || uuid();
  await pool.query(
    // last_season_dbt_status is always given a real value here (never
    // left to default to NULL) -- pg-mem mis-evaluates a nullable
    // `CHECK (col IN (...))` against NULL as a violation, which real
    // Postgres correctly treats as passing (NULL IN (...) is UNKNOWN,
    // not FALSE). Schema is right; this sidesteps the test-only bug.
    `INSERT INTO farmers (id, farmer_name, land_record_id, is_tenant, phone, last_season_dbt_status, registered_channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      overrides.farmerName || 'Test Farmer',
      overrides.landRecordId ?? null,
      overrides.isTenant || false,
      overrides.phone || `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      overrides.lastSeasonDbtStatus || 'success',
      overrides.registeredChannel || 'counter',
    ]
  );
  return id;
}

// Convenience: a farmer with their own land record of a given size.
async function insertFarmerWithLand(pool, { extentAcres = 2.5, ...rest } = {}) {
  const landRecordId = await insertLandRecord(pool, { extentAcres });
  return insertFarmer(pool, { ...rest, landRecordId });
}

module.exports = {
  insertCentre,
  insertDailyInputs,
  insertLandRecord,
  insertFarmer,
  insertFarmerWithLand,
  DAILY_INPUT_BASELINE,
};
