'use strict';

const crypto = require('crypto');
const { computeDailyCapacity } = require('../src/capacityEngine');
const { YIELD_QUINTALS_PER_ACRE, BAGS_PER_QUINTAL, OVER_DECLARE_CAP_MULTIPLIER, KG_PER_BAG } = require('../src/constants');
const { createRng } = require('./seed/random');
const { generateVillageNames, generatePersonName, generateFatherName } = require('./seed/names');
const { SHARED_BASELINE, CENTRES } = require('./seed/centres');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SEED = Number((args.find((a) => a.startsWith('--seed=')) || '--seed=42').split('=')[1]);

const DISTRICT = 'Medak';
const STATE = 'Telangana';
const SERVICE_DATES = 7; // seed a week of centre-day capacity
const START_DATE = '2026-09-04';

// The district dashboard's gunny-cover figure needs real burn history --
// completed lots with weighments -- for the 3 days before the dashboard
// date, or its rolling burn rate has nothing to divide by. Backfilled
// below, immediately before START_DATE.
const BURN_HISTORY_DAYS = 3;
// The two busiest APMC mandis: sized (see buildBurnHistory) to have burned
// through most of their gunny stock during a peak-season stretch, so they
// trip the dashboard's under-1.5-day alert. Every other centre gets a
// comfortable multi-day cushion.
const AT_RISK_CENTRE_CODES = new Set(['MDK-APMC-01', 'MDK-APMC-02']);

const TOTAL_FARMERS = 5000;
const UNMATCHED_RATIO = 0.15;
const TENANT_RATIO = 0.05;
const DBT_FAILED_RATIO = 0.03;
const OVER_DECLARE_PROBABILITY = 0.02;

const VILLAGES_PER_CENTRE = 5;

const IFSC_PREFIXES = ['SBIN', 'HDFC', 'ICIC', 'PUNB', 'UBIN', 'TGGB', 'APGB', 'IDIB'];
const CHANNEL_WEIGHTS = [
  ['counter', 35],
  ['ivr', 25],
  ['sms', 25],
  ['app', 15],
];

function uuid() {
  return crypto.randomUUID();
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function jitterInt(rng, value, pct) {
  return Math.max(0, Math.round(value * rng.float(1 - pct, 1 + pct)));
}

function jitterFloat(rng, value, pct, decimals = 2) {
  return round(value * rng.float(1 - pct, 1 + pct), decimals);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function randomPhone(rng, used) {
  let phone;
  do {
    phone = `${rng.pick(['6', '7', '8', '9'])}${Array.from({ length: 9 }, () => rng.int(0, 9)).join('')}`;
  } while (used.has(phone));
  used.add(phone);
  return phone;
}

function randomBankAccountNumber(rng) {
  return Array.from({ length: 14 }, () => rng.int(0, 9)).join('');
}

function randomIfsc(rng) {
  return `${rng.pick(IFSC_PREFIXES)}0${String(rng.int(0, 999999)).padStart(6, '0')}`;
}

function randomSurveyNumber(rng) {
  return `${rng.int(1, 450)}/${rng.pick(['A', 'B', '1', '2', '3', 'AA'])}`;
}

function randomExtentAcres(rng) {
  return Math.min(25, Math.max(0.1, round(rng.lognormal(2.5, 0.6), 2)));
}

// ---------------------------------------------------------------------------
// Centres + centre-day capacity
// ---------------------------------------------------------------------------

// Villages cluster within ~3-13km of their centre's town -- plausible for
// a mandal's surrounding villages without claiming survey accuracy. Each
// village name gets one fixed coordinate, reused by every land record in
// that village (a village has one location, not one per farmer).
function buildVillageCoords(rng, villages, centreLat, centreLng) {
  const coords = {};
  for (const village of villages) {
    const bearing = rng.float(0, 2 * Math.PI);
    const distanceDeg = rng.float(0.03, 0.12);
    coords[village] = {
      lat: round(centreLat + distanceDeg * Math.cos(bearing), 6),
      lng: round(centreLng + distanceDeg * Math.sin(bearing), 6),
    };
  }
  return coords;
}

function buildCentres(rng) {
  const villagePool = generateVillageNames(rng, CENTRES.length * VILLAGES_PER_CENTRE);

  return CENTRES.map((profile, index) => {
    const villages = villagePool.slice(index * VILLAGES_PER_CENTRE, (index + 1) * VILLAGES_PER_CENTRE);
    return {
      id: uuid(),
      name: profile.name,
      code: profile.code,
      centreType: profile.centreType,
      weighingMode: profile.weighingMode,
      lat: profile.lat,
      lng: profile.lng,
      intendedBottleneck: profile.intendedBottleneck,
      overrides: profile.overrides,
      villages,
      villageCoords: buildVillageCoords(rng, villages, profile.lat, profile.lng),
    };
  });
}

function buildCentreDays(rng, centres) {
  const centreDailyInputs = [];
  const centreDays = [];

  for (const centre of centres) {
    for (let dayOffset = 0; dayOffset < SERVICE_DATES; dayOffset++) {
      const serviceDate = addDays(START_DATE, dayOffset);
      const merged = { ...SHARED_BASELINE, ...centre.overrides };

      const dailyInput = {
        id: uuid(),
        centreId: centre.id,
        serviceDate,
        weighingMode: centre.weighingMode,
        weighbridgeOperatingMinutes: jitterInt(rng, merged.weighbridgeOperatingMinutes, 0.05),
        weighbridgeAvgCycleMinutes:
          centre.weighingMode === 'weighbridge' ? jitterFloat(rng, merged.weighbridgeAvgCycleMinutes, 0.1, 1) : null,
        secondsPerBag: centre.weighingMode === 'platform' ? jitterFloat(rng, merged.secondsPerBag, 0.1, 1) : null,
        avgBagsPerLot: centre.weighingMode === 'platform' ? jitterInt(rng, merged.avgBagsPerLot, 0.1) : null,
        hamaliGangCount: jitterInt(rng, merged.hamaliGangCount, 0.1),
        hamaliBagsPerGangPerDay: jitterInt(rng, merged.hamaliBagsPerGangPerDay, 0.1),
        bagsPerTruck: merged.bagsPerTruck,
        gunnyBagsAvailable: jitterInt(rng, merged.gunnyBagsAvailable, 0.1),
        truckEvacuationCapacity: jitterInt(rng, merged.truckEvacuationCapacity, 0.1),
        yardCapacityTonnes: merged.yardCapacityTonnes,
        undispatchedTonnes: jitterFloat(rng, merged.undispatchedTonnes, 0.15, 2),
        avgTruckLoadTonnes: merged.avgTruckLoadTonnes,
        moistureMeterCount: merged.moistureMeterCount,
        moistureTestsPerMeterPerDay: merged.moistureTestsPerMeterPerDay,
      };
      centreDailyInputs.push(dailyInput);

      const engineResult = computeDailyCapacity({
        weighingMode: dailyInput.weighingMode,
        weighbridgeOperatingMinutes: dailyInput.weighbridgeOperatingMinutes,
        weighbridgeAvgCycleMinutes: dailyInput.weighbridgeAvgCycleMinutes ?? undefined,
        secondsPerBag: dailyInput.secondsPerBag ?? undefined,
        avgBagsPerLot: dailyInput.avgBagsPerLot ?? undefined,
        hamaliGangCount: dailyInput.hamaliGangCount,
        hamaliBagsPerGangPerDay: dailyInput.hamaliBagsPerGangPerDay,
        bagsPerTruck: dailyInput.bagsPerTruck,
        gunnyBagsAvailable: dailyInput.gunnyBagsAvailable,
        truckEvacuationCapacity: dailyInput.truckEvacuationCapacity,
        yardCapacityTonnes: dailyInput.yardCapacityTonnes - dailyInput.undispatchedTonnes,
        avgTruckLoadTonnes: dailyInput.avgTruckLoadTonnes,
        moistureMeterCount: dailyInput.moistureMeterCount,
        moistureTestsPerMeterPerDay: dailyInput.moistureTestsPerMeterPerDay,
      });

      centreDays.push({
        id: uuid(),
        centreId: centre.id,
        centreName: centre.name,
        centreCode: centre.code,
        serviceDate,
        bagsPerTruck: dailyInput.bagsPerTruck,
        totalCapacity: engineResult.totalCapacity,
        walkInReserved: engineResult.walkInReserved,
        bookableCapacity: engineResult.bookableCapacity,
        bagsCapacity: engineResult.bookableCapacity * dailyInput.bagsPerTruck,
        bagsBooked: 0, // accumulated in buildBookings as bookings are packed in
        bindingConstraint: engineResult.bindingConstraint,
        constraintBreakdown: engineResult.constraints,
      });
    }
  }

  return { centreDailyInputs, centreDays };
}

// ---------------------------------------------------------------------------
// Land records + farmers (dirty data)
// ---------------------------------------------------------------------------

function buildFarmersAndLandRecords(rng, centres) {
  const landRecords = [];
  const farmers = [];
  const usedPhones = new Set();
  let landRecordSeq = 1;

  const indices = Array.from({ length: TOTAL_FARMERS }, (_, i) => i);
  const shuffledForMatch = rng.shuffle(indices);
  const unmatchedCount = Math.round(TOTAL_FARMERS * UNMATCHED_RATIO);
  const tenantCount = Math.round(TOTAL_FARMERS * TENANT_RATIO);

  const unmatchedSet = new Set(shuffledForMatch.slice(0, unmatchedCount));
  const tenantSet = new Set(shuffledForMatch.slice(unmatchedCount, unmatchedCount + tenantCount));

  const shuffledForDbt = rng.shuffle(indices);
  const dbtFailedCount = Math.round(TOTAL_FARMERS * DBT_FAILED_RATIO);
  const dbtFailedSet = new Set(shuffledForDbt.slice(0, dbtFailedCount));

  function makeLandRecord(farmerName, village, coords) {
    const record = {
      id: uuid(),
      landRecordNumber: `MDK-DHARANI-${String(landRecordSeq).padStart(6, '0')}`,
      farmerName,
      fatherName: generateFatherName(rng),
      village,
      lat: coords.lat,
      lng: coords.lng,
      surveyNumber: randomSurveyNumber(rng),
      extentAcres: randomExtentAcres(rng),
      crop: 'Paddy',
    };
    landRecordSeq += 1;
    landRecords.push(record);
    return record;
  }

  for (let i = 0; i < TOTAL_FARMERS; i++) {
    const centre = centres[i % centres.length];
    const village = rng.pick(centre.villages);
    const villageCoords = centre.villageCoords[village];
    const farmerName = generatePersonName(rng);
    const isUnmatched = unmatchedSet.has(i);
    const isTenant = tenantSet.has(i);

    let landRecordId = null;
    let linkedExtentAcres = null;

    if (isUnmatched) {
      // Dharani lookup found nothing -- no land_records row exists for this
      // registration attempt at all.
      landRecordId = null;
    } else if (isTenant) {
      // Cultivates land recorded under someone else's name.
      let ownerName = generatePersonName(rng);
      while (ownerName === farmerName) ownerName = generatePersonName(rng);
      const record = makeLandRecord(ownerName, village, villageCoords);
      landRecordId = record.id;
      linkedExtentAcres = record.extentAcres;
    } else {
      const record = makeLandRecord(farmerName, village, villageCoords);
      landRecordId = record.id;
      linkedExtentAcres = record.extentAcres;
    }

    farmers.push({
      id: uuid(),
      farmerName,
      landRecordId,
      isTenant,
      matchStatus: isUnmatched ? 'unmatched' : isTenant ? 'tenant' : 'matched_own',
      linkedExtentAcres,
      phone: randomPhone(rng, usedPhones),
      bankAccountNumber: randomBankAccountNumber(rng),
      bankIfsc: randomIfsc(rng),
      bankAccountHolderName: farmerName,
      lastSeasonDbtStatus: dbtFailedSet.has(i) ? 'failed' : 'success',
      registeredChannel: rng.pickWeighted(CHANNEL_WEIGHTS),
    });
  }

  return { landRecords, farmers };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

function buildBookings(rng, centreDays, farmers) {
  const bookings = [];
  const candidates = rng.shuffle(farmers.filter((f) => f.landRecordId !== null));
  let cursor = 0;
  let overDeclaredCount = 0;

  for (const centreDay of centreDays) {
    let remainingBags = centreDay.bagsCapacity;
    let sequence = 0;

    while (cursor < candidates.length) {
      const farmer = candidates[cursor];

      const landEstimate = round(farmer.linkedExtentAcres * YIELD_QUINTALS_PER_ACRE, 2);
      const overDeclares = rng.bool(OVER_DECLARE_PROBABILITY);
      const declaredQuantity = overDeclares
        ? round(landEstimate * rng.float(1.35, 1.6), 2)
        : round(landEstimate * rng.float(0.7, 1.15), 2);
      const bagsReserved = round(declaredQuantity * BAGS_PER_QUINTAL, 2);

      if (bagsReserved > remainingBags) break; // doesn't fit here -- move to the next centre-day

      cursor += 1;
      sequence += 1;
      remainingBags -= bagsReserved;
      centreDay.bagsBooked += bagsReserved;
      if (overDeclares) overDeclaredCount += 1;

      const dateCompact = centreDay.serviceDate.replace(/-/g, '');
      bookings.push({
        id: uuid(),
        centreDayId: centreDay.id,
        farmerId: farmer.id,
        token: `${centreDay.centreCode}-${dateCompact}-${String(sequence).padStart(3, '0')}`,
        declaredQuantityQuintals: declaredQuantity,
        bagsReserved,
        landEstimateQuintals: landEstimate,
        overDeclared: declaredQuantity > OVER_DECLARE_CAP_MULTIPLIER * landEstimate,
        bookingChannel: rng.pickWeighted(CHANNEL_WEIGHTS),
      });
    }
    if (cursor >= candidates.length) break;
  }

  return { bookings, overDeclaredCount };
}

// ---------------------------------------------------------------------------
// Burn history (backfilled completed lots, for the dashboard's gunny-cover
// burn rate)
// ---------------------------------------------------------------------------

// Backfills BURN_HISTORY_DAYS days of completed lots (with weighments)
// immediately before START_DATE, one synthetic centre_day per day per
// centre. Sized backwards from each centre's already-generated
// START_DATE+1 gunny stock, so the resulting days-of-cover lands where we
// want it -- a couple of centres genuinely low, the rest comfortable --
// rather than picking a burn number and hoping the ratio comes out right.
// Bookings are real farmer-sized draws (same land-estimate math as
// buildBookings), packed against a per-day target instead of a capacity
// ceiling, and marked 'completed' with a same-day weighment whose net_kg
// matches bags_reserved exactly (KG_PER_BAG), so gunny cover derived from
// them is internally consistent top to bottom.
function buildBurnHistory(rng, centres, centreDailyInputs, farmers) {
  const candidates = rng.shuffle(farmers.filter((f) => f.landRecordId !== null));
  let cursor = 0;

  const historicalCentreDays = [];
  const historicalBookings = [];
  const historicalWeighments = [];
  const burnSummary = [];

  const tomorrow = addDays(START_DATE, 1);

  for (const centre of centres) {
    const tomorrowInput = centreDailyInputs.find((d) => d.centreId === centre.id && d.serviceDate === tomorrow);
    const gunnyTomorrow = tomorrowInput.gunnyBagsAvailable;

    const atRisk = AT_RISK_CENTRE_CODES.has(centre.code);
    // Comfortable margin under the dashboard's 1.5-day alert threshold --
    // packing bookings against a target only approximates it, so this
    // needs slack, not a target that grazes the boundary.
    const targetCoverDays = atRisk ? rng.float(0.5, 1.1) : rng.float(3, 9);
    const avgDailyBurn = Math.max(200, Math.round(gunnyTomorrow / targetCoverDays));

    let totalBurned = 0;

    for (let dayOffset = BURN_HISTORY_DAYS; dayOffset >= 1; dayOffset--) {
      const serviceDate = addDays(START_DATE, -dayOffset);
      const dailyTarget = jitterInt(rng, avgDailyBurn, 0.15);
      const centreDayId = uuid();

      let remainingTarget = dailyTarget;
      let sequence = 0;
      let dayBurned = 0;

      while (cursor < candidates.length && remainingTarget > avgDailyBurn * 0.05) {
        const farmer = candidates[cursor];
        const landEstimate = round(farmer.linkedExtentAcres * YIELD_QUINTALS_PER_ACRE, 2);
        const declaredQuantity = round(landEstimate * rng.float(0.7, 1.15), 2);
        const bagsReserved = round(declaredQuantity * BAGS_PER_QUINTAL, 2);

        if (bagsReserved > remainingTarget * 1.5) {
          cursor += 1; // too big for what's left today -- try the next farmer rather than stall
          continue;
        }

        cursor += 1;
        sequence += 1;
        remainingTarget -= bagsReserved;
        dayBurned += bagsReserved;

        const dateCompact = serviceDate.replace(/-/g, '');
        const bookingId = uuid();
        const netKg = round(bagsReserved * KG_PER_BAG, 2);

        historicalBookings.push({
          id: bookingId,
          centreDayId,
          farmerId: farmer.id,
          token: `${centre.code}-${dateCompact}-${String(sequence).padStart(3, '0')}`,
          declaredQuantityQuintals: declaredQuantity,
          bagsReserved,
          bookingChannel: rng.pickWeighted(CHANNEL_WEIGHTS),
          status: 'completed',
          checkedInAt: `${serviceDate}T06:30:00Z`,
          completedAt: `${serviceDate}T15:00:00Z`,
        });

        historicalWeighments.push({
          id: uuid(),
          bookingId,
          mode: 'weighbridge',
          grossKg: netKg,
          tareKg: 0,
          netKg,
        });
      }

      historicalCentreDays.push({
        id: centreDayId,
        centreId: centre.id,
        centreName: centre.name,
        centreCode: centre.code,
        serviceDate,
        bagsPerTruck: SHARED_BASELINE.bagsPerTruck,
        totalCapacity: Math.ceil(dayBurned / SHARED_BASELINE.bagsPerTruck),
        walkInReserved: 0,
        bookableCapacity: Math.ceil(dayBurned / SHARED_BASELINE.bagsPerTruck),
        bagsCapacity: dayBurned,
        bagsBooked: dayBurned,
        // Not really "gunny-bound" for every historical day -- these rows
        // exist purely to carry burn history, not a real capacity
        // breakdown -- but binding_constraint is a required enum column,
        // and gunny is the one this backfill is actually about.
        bindingConstraint: 'gunny',
        constraintBreakdown: {},
      });

      totalBurned += dayBurned;
    }

    const avgBurnActual = round(totalBurned / BURN_HISTORY_DAYS, 1);
    burnSummary.push({
      centreName: centre.name,
      centreCode: centre.code,
      avgDailyBurn: avgBurnActual,
      gunnyTomorrow,
      daysOfCover: avgBurnActual > 0 ? round(gunnyTomorrow / avgBurnActual, 1) : null,
    });
  }

  return { historicalCentreDays, historicalBookings, historicalWeighments, burnSummary };
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function batchInsert(client, table, columns, rows, getValues, chunkSize = 500) {
  if (rows.length === 0) return;

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = [];
    const tuples = chunk.map((row, i) => {
      const rowValues = getValues(row);
      values.push(...rowValues);
      const base = i * columns.length;
      const placeholders = rowValues.map((_, j) => `$${base + j + 1}`);
      return `(${placeholders.join(', ')})`;
    });

    const text = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`;
    await client.query(text, values);
  }
}

async function writeToDatabase({ centres, centreDailyInputs, centreDays, landRecords, farmers, bookings, weighments }) {
  const { Client } = require('pg');
  const client = new Client();
  await client.connect();

  try {
    await client.query('BEGIN');

    await batchInsert(
      client,
      'centres',
      ['id', 'name', 'code', 'centre_type', 'district', 'state', 'latitude', 'longitude'],
      centres,
      (c) => [c.id, c.name, c.code, c.centreType, DISTRICT, STATE, c.lat, c.lng]
    );

    await batchInsert(
      client,
      'centre_daily_inputs',
      [
        'id', 'centre_id', 'service_date', 'weighing_mode',
        'weighbridge_operating_minutes', 'weighbridge_avg_cycle_minutes', 'seconds_per_bag', 'avg_bags_per_lot',
        'hamali_gang_count', 'hamali_bags_per_gang_per_day', 'bags_per_truck', 'gunny_bags_available',
        'truck_evacuation_capacity', 'yard_capacity_tonnes', 'undispatched_tonnes', 'avg_truck_load_tonnes',
        'moisture_meter_count', 'moisture_tests_per_meter_per_day',
      ],
      centreDailyInputs,
      (d) => [
        d.id, d.centreId, d.serviceDate, d.weighingMode,
        d.weighbridgeOperatingMinutes, d.weighbridgeAvgCycleMinutes, d.secondsPerBag, d.avgBagsPerLot,
        d.hamaliGangCount, d.hamaliBagsPerGangPerDay, d.bagsPerTruck, d.gunnyBagsAvailable,
        d.truckEvacuationCapacity, d.yardCapacityTonnes, d.undispatchedTonnes, d.avgTruckLoadTonnes,
        d.moistureMeterCount, d.moistureTestsPerMeterPerDay,
      ]
    );

    await batchInsert(
      client,
      'centre_day',
      [
        'id', 'centre_id', 'service_date', 'total_capacity', 'walk_in_reserved', 'bookable_capacity',
        'bags_capacity', 'bags_booked', 'binding_constraint', 'constraint_breakdown',
      ],
      centreDays,
      (s) => [
        s.id, s.centreId, s.serviceDate, s.totalCapacity, s.walkInReserved, s.bookableCapacity,
        s.bagsCapacity, s.bagsBooked, s.bindingConstraint, JSON.stringify(s.constraintBreakdown),
      ]
    );

    await batchInsert(
      client,
      'land_records',
      [
        'id', 'land_record_number', 'farmer_name', 'father_name', 'village', 'latitude', 'longitude',
        'survey_number', 'extent_acres', 'crop',
      ],
      landRecords,
      (l) => [
        l.id, l.landRecordNumber, l.farmerName, l.fatherName, l.village, l.lat, l.lng,
        l.surveyNumber, l.extentAcres, l.crop,
      ]
    );

    await batchInsert(
      client,
      'farmers',
      [
        'id', 'farmer_name', 'land_record_id', 'is_tenant', 'phone',
        'bank_account_number', 'bank_ifsc', 'bank_account_holder_name', 'last_season_dbt_status', 'registered_channel',
      ],
      farmers,
      (f) => [
        f.id, f.farmerName, f.landRecordId, f.isTenant, f.phone,
        f.bankAccountNumber, f.bankIfsc, f.bankAccountHolderName, f.lastSeasonDbtStatus, f.registeredChannel,
      ]
    );

    await batchInsert(
      client,
      'bookings',
      [
        'id', 'centre_day_id', 'farmer_id', 'token', 'declared_quantity_quintals', 'bags_reserved', 'booking_channel',
        'status', 'checked_in_at', 'completed_at',
      ],
      bookings,
      (b) => [
        b.id, b.centreDayId, b.farmerId, b.token, b.declaredQuantityQuintals, b.bagsReserved, b.bookingChannel,
        b.status || 'booked', b.checkedInAt || null, b.completedAt || null,
      ]
    );

    await batchInsert(
      client,
      'lot_weighments',
      ['id', 'booking_id', 'mode', 'gross_kg', 'tare_kg', 'net_kg'],
      weighments,
      (w) => [w.id, w.bookingId, w.mode, w.grossKg, w.tareKg, w.netKg]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary({ centres, centreDays, landRecords, farmers, bookings, overDeclaredCount, burnSummary }) {
  const line = (s = '') => console.log(s);

  line('='.repeat(72));
  line('SIH 26032 -- Kisan Slot seed summary');
  line('='.repeat(72));

  line(`\nCentres: ${centres.length} (Medak district)`);
  const byType = centres.reduce((acc, c) => {
    acc[c.centreType] = (acc[c.centreType] || 0) + 1;
    return acc;
  }, {});
  for (const [type, count] of Object.entries(byType)) {
    line(`  ${type}: ${count}`);
  }

  line(`\nCentre-day capacity rows: ${centreDays.length} (${SERVICE_DATES} days x ${centres.length} centres)`);
  line('  Binding constraint, by centre (first seeded day):');
  for (const centre of centres) {
    const firstDay = centreDays.find((d) => d.centreId === centre.id);
    const match = firstDay.bindingConstraint === centre.intendedBottleneck.split(' ')[0] ? '' : '  [differs from intended]';
    line(`    ${centre.name.padEnd(24)} intended: ${centre.intendedBottleneck.padEnd(48)} actual: ${firstDay.bindingConstraint} (${firstDay.totalCapacity}/day)${match}`);
  }
  const bindingHistogram = centreDays.reduce((acc, d) => {
    acc[d.bindingConstraint] = (acc[d.bindingConstraint] || 0) + 1;
    return acc;
  }, {});
  line('  Binding constraint distribution across all centre-days:');
  for (const [constraint, count] of Object.entries(bindingHistogram)) {
    line(`    ${constraint}: ${count}`);
  }
  const totalBookable = centreDays.reduce((sum, d) => sum + d.bookableCapacity, 0);
  line(`  Total bookable capacity across the week: ${totalBookable}`);

  line(`\nLand records: ${landRecords.length}`);

  line(`\nFarmers: ${farmers.length}`);
  const byMatchStatus = farmers.reduce((acc, f) => {
    acc[f.matchStatus] = (acc[f.matchStatus] || 0) + 1;
    return acc;
  }, {});
  for (const [status, count] of Object.entries(byMatchStatus)) {
    line(`  ${status}: ${count} (${((count / farmers.length) * 100).toFixed(1)}%)`);
  }
  const dbtFailed = farmers.filter((f) => f.lastSeasonDbtStatus === 'failed').length;
  line(`  DBT failed last season: ${dbtFailed} (${((dbtFailed / farmers.length) * 100).toFixed(1)}%)`);

  line(`\nBookings: ${bookings.length}`);
  line(`  Declared quantity > 1.3x land-record estimate: ${overDeclaredCount} (${((overDeclaredCount / bookings.length) * 100).toFixed(1)}%)`);

  line(`\nBurn history backfill (${BURN_HISTORY_DAYS} days before ${START_DATE}), for the district dashboard's gunny cover:`);
  for (const b of burnSummary) {
    const flag = b.daysOfCover !== null && b.daysOfCover < 1.5 ? '  [AT RISK]' : '';
    line(`    ${b.centreName.padEnd(24)} avg burn: ${String(b.avgDailyBurn).padStart(6)} bags/day   gunny (${addDays(START_DATE, 1)}): ${String(b.gunnyTomorrow).padStart(6)}   days of cover: ${b.daysOfCover}${flag}`);
  }

  line('\n' + '='.repeat(72));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rng = createRng(SEED);

  const centres = buildCentres(rng);
  const { centreDailyInputs, centreDays } = buildCentreDays(rng, centres);
  const { landRecords, farmers } = buildFarmersAndLandRecords(rng, centres);
  const { historicalCentreDays, historicalBookings, historicalWeighments, burnSummary } = buildBurnHistory(
    rng,
    centres,
    centreDailyInputs,
    farmers
  );
  const { bookings, overDeclaredCount } = buildBookings(rng, centreDays, farmers);

  const allCentreDays = [...centreDays, ...historicalCentreDays];
  const allBookings = [...bookings, ...historicalBookings];

  if (DRY_RUN) {
    console.log(`[dry run, seed=${SEED}] generated in memory, nothing written to the database.\n`);
  } else {
    await writeToDatabase({
      centres,
      centreDailyInputs,
      centreDays: allCentreDays,
      landRecords,
      farmers,
      bookings: allBookings,
      weighments: historicalWeighments,
    });
  }

  printSummary({ centres, centreDays, landRecords, farmers, bookings, overDeclaredCount, burnSummary });
}

main().catch((err) => {
  console.error('Seed failed:', err.message || err.code || err);
  if (!DRY_RUN) {
    console.error('Make sure db/migrations/001_init_schema.sql has been applied and DATABASE_URL (or PGHOST/PGUSER/...) points at it.');
  }
  process.exitCode = 1;
});
