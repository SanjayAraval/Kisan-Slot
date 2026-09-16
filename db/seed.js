'use strict';

const crypto = require('crypto');
const { computeDailyCapacity, CONSTRAINT_ORDER } = require('../src/capacityEngine');
const { YIELD_QUINTALS_PER_ACRE, BAGS_PER_QUINTAL, OVER_DECLARE_CAP_MULTIPLIER, KG_PER_BAG } = require('../src/constants');
const { createRng } = require('./seed/random');
const { generateVillageNames, generatePersonName, generateFatherName } = require('./seed/names');
const { SHARED_BASELINE, CENTRES } = require('./seed/centres');
const { buildEmployees } = require('./seed/employees');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SEED = Number((args.find((a) => a.startsWith('--seed=')) || '--seed=42').split('=')[1]);

const DISTRICT = 'Medak';
const STATE = 'Telangana';
const SERVICE_DATES = 7; // seed a week of centre-day capacity

// Same IST-calendar-day convention as app.js's todayInIST -- declarations
// have to start from the real "today" (not a fixed historical string) or
// every seeded service date is already in the past by the time anyone
// looks at the dashboard, and a farmer can't book against any of them
// (validateBookingDate rejects a past date outright).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function todayInIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
const START_DATE = todayInIST();

// The district dashboard's gunny-cover figure needs real burn history --
// completed lots with weighments -- for the BURN_RATE_WINDOW_DAYS
// (dashboardService.js) calendar days before the dashboard date, or its
// rolling burn rate has nothing to divide by. The dashboard defaults to
// viewing *tomorrow* (START_DATE + 1) -- see dashboard.html's
// todayPlusOne() -- so that window is [START_DATE-2, START_DATE+1):
// START_DATE-2, START_DATE-1, and START_DATE itself. START_DATE can't be
// backfilled here -- it's already the first day of the *future* declared
// window from buildCentreDays, which owns that (centre, service_date)
// pair in centre_day (UNIQUE(centre_id, service_date)) -- so only
// BURN_HISTORY_DAYS-1 days actually get completed lots (see
// buildBurnHistory, which scales each one up so the live 3-day average,
// computed over 2 real days and one empty one, still lands where
// intended rather than reading 1/3 low).
const BURN_HISTORY_DAYS = 3;
// The two busiest APMC mandis: sized (see buildBurnHistory) to have burned
// through most of their gunny stock during a peak-season stretch, so they
// trip the dashboard's under-1.5-day alert. Every other centre gets a
// comfortable multi-day cushion.
const AT_RISK_CENTRE_CODES = new Set(['MDK-APMC-01', 'MDK-APMC-02']);

// The nightly reallocation job only ever produces a deferral when
// confirmed bookings for a future date outnumber what centre_daily_inputs
// recomputes for that date (reallocationJob.buildSnapshot always
// recomputes fresh from centre_daily_inputs -- see loadConfirmedBookings /
// planNightlyReallocation -- rather than trusting the centre_day snapshot).
// Left alone, buildBookings never overshoots: it packs farmers against
// each centre_day's own bagsCapacity and stops. So these two centres get
// their tomorrow (D+1) centre_daily_inputs quietly cut *after* bookings
// were already packed against the original, higher number -- mimicking
// an officer re-declaring reduced capacity (a labour no-show, a
// half-day equipment outage) later the same day, before the nightly job
// has caught up. Deliberately not APMC-01/02 -- those two are already
// telling the separate gunny-cover story above; mixing the two would
// muddy both.
const OVERBOOKED_CENTRE_CODES = new Set(['MDK-PACS-02', 'MDK-IKP-01']);
// Fraction of the already-booked bags that tomorrow's cut capacity should
// land at -- comfortably below 1 so a real, multi-farmer deferral list
// comes out (not just one farmer at the margin), comfortably above 0 so
// most bookings are still kept and the score ranking has something to bite.
const OVERBOOKED_TARGET_RATIO_RANGE = [0.45, 0.65];

// A handful of today's (D) bookings get marked as no-shows so the nightly
// job's noShowReleases (reallocationJob.loadNoShowBookings, keyed on
// status = 'no_show' AND capacity_released_at IS NULL for the job's own
// `today`) has something real to release, exactly like a live run would
// see after gate staff mark absent farmers during the day.
const NO_SHOW_COUNT = 6;

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
      nameHi: profile.nameHi,
      nameTe: profile.nameTe,
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
// Deliberate overbooking (so the nightly reallocation job has a real
// deferral list to produce)
// ---------------------------------------------------------------------------

// Which lever each overbooked centre's cut turns -- the constraint it's
// already tightest on per its `intendedBottleneck` (see centres.js), so
// the cut reads as "the existing bottleneck got worse", not an
// implausible across-the-board collapse.
const OVERBOOKED_CENTRE_LEVERS = {
  // hamaliBagsPerGangPerDay (each gang's throughput, e.g. rain-slowed
  // bagging), not hamaliGangCount -- a whole gang is too coarse a step to
  // land anywhere near OVERBOOKED_TARGET_RATIO_RANGE without overshooting.
  'MDK-PACS-02': (dailyInput) => {
    dailyInput.hamaliBagsPerGangPerDay = Math.max(50, Math.round(dailyInput.hamaliBagsPerGangPerDay * 0.9));
  },
  'MDK-IKP-01': (dailyInput) => {
    dailyInput.weighbridgeOperatingMinutes = Math.max(30, Math.round(dailyInput.weighbridgeOperatingMinutes * 0.9));
  },
};

function engineInputFrom(dailyInput) {
  return {
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
  };
}

// Mutates centreDailyInputs in place only -- centreDays (and its already-
// written bagsBooked/bagsCapacity, which the seed's own centre_day INSERT
// must keep bags_booked <= bags_capacity for) is left exactly as
// buildBookings packed it. The resulting gap between the two is what
// reallocationJob.buildSnapshot picks up: it always recomputes bagsCapacity
// fresh from centre_daily_inputs rather than trusting the centre_day
// snapshot, so tomorrow's real (cut) capacity vs. the bookings already on
// file is exactly the "capacity_reduced" scenario planNightlyReallocation
// exists to resolve.
function applyOverbookingScenario(rng, centres, centreDailyInputs, centreDays) {
  const tomorrow = addDays(START_DATE, 1);
  const summary = [];

  for (const centre of centres) {
    const lever = OVERBOOKED_CENTRE_LEVERS[centre.code];
    if (!lever) continue;

    const dailyInput = centreDailyInputs.find((d) => d.centreId === centre.id && d.serviceDate === tomorrow);
    const centreDay = centreDays.find((d) => d.centreId === centre.id && d.serviceDate === tomorrow);
    const bagsBookedBefore = centreDay.bagsBooked;
    const originalBagsCapacity = centreDay.bagsCapacity;
    const targetBagsCapacity = bagsBookedBefore * rng.float(...OVERBOOKED_TARGET_RATIO_RANGE);

    let cutBagsCapacity = originalBagsCapacity;
    let guard = 0;
    while (cutBagsCapacity > targetBagsCapacity && guard < 500) {
      lever(dailyInput);
      const engineResult = computeDailyCapacity(engineInputFrom(dailyInput));
      cutBagsCapacity = engineResult.bookableCapacity * dailyInput.bagsPerTruck;
      guard += 1;
    }

    summary.push({
      centreName: centre.name,
      centreCode: centre.code,
      date: tomorrow,
      bagsBooked: bagsBookedBefore,
      originalBagsCapacity,
      cutBagsCapacity,
    });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// No-shows (so the nightly job's no-show release is non-zero)
// ---------------------------------------------------------------------------

// Picks a few of today's (D) plain 'booked' bookings and marks them
// 'no_show' -- capacity_released_at stays NULL (it isn't one of the
// insert columns), matching a live gate-side no-show mark that the
// nightly job hasn't released yet.
function applyNoShowScenario(rng, bookings, centreDays, count) {
  const todayCentreDayIds = new Set(centreDays.filter((d) => d.serviceDate === START_DATE).map((d) => d.id));
  const eligible = rng.shuffle(bookings.filter((b) => todayCentreDayIds.has(b.centreDayId)));
  const chosen = eligible.slice(0, count);
  for (const booking of chosen) {
    booking.status = 'no_show';
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Burn history (backfilled completed lots, for the dashboard's gunny-cover
// burn rate)
// ---------------------------------------------------------------------------

// Excludes gunny -- the one constraint this function itself is about to
// move -- from the "what could this centre physically process" figure.
// The other five (weighbridge/hamali/truckEvacuation/yardSpace/
// moistureTesting) are fixed infrastructure, unaffected by today's
// leftover bag count, so they're the genuine, non-circular ceiling on
// burn: a centre's throughput doesn't drop just because we're about to
// declare it low on bags, and using totalCapacity itself here (which
// already folds gunny in) would make the cap move every time gunny does.
function nonGunnyCapacityBags(constraintBreakdown, bagsPerTruck) {
  const lotsPerDay = Math.min(
    ...CONSTRAINT_ORDER.filter((key) => key !== 'gunny').map((key) => constraintBreakdown[key])
  );
  return lotsPerDay * bagsPerTruck;
}

// Backfills completed lots (with weighments) for the BURN_HISTORY_DAYS-1
// days that can actually carry them (see the comment on BURN_HISTORY_DAYS
// above), one synthetic centre_day per day per centre.
//
// Burn is capped at nonGunnyCapacityBags -- a centre can never be shown
// consuming more bags in a day than its declared infrastructure could
// physically weigh/handle/evacuate, no matter how much gunny stock is on
// hand. For the two AT_RISK centres, burn is set *near* that physical
// ceiling (running flat out) and it's tomorrow's gunny stock that's sized
// down from it afterwards -- not the other way around -- so days-of-cover
// lands under the dashboard's 1.5-day alert without ever implying burn
// the centre couldn't actually sustain. The declaration row (and its
// already-computed centre_day capacity) is mutated in place so the
// declaration screen, dashboard capacity figure and gunny-cover figure
// all agree on the same lowered stock. Every other centre keeps its
// original, generous gunny stock and just gets its burn capped the same
// way, for a comfortable multi-day cushion.
//
// Bookings are real farmer-sized draws (same land-estimate math as
// buildBookings), packed against a per-day target instead of a capacity
// ceiling, and marked 'completed' with a same-day weighment whose net_kg
// matches bags_reserved exactly (KG_PER_BAG), so gunny cover derived from
// them is internally consistent top to bottom.
function buildBurnHistory(rng, centres, centreDailyInputs, centreDays, farmers) {
  const candidates = rng.shuffle(farmers.filter((f) => f.landRecordId !== null));
  let cursor = 0;

  const historicalCentreDays = [];
  const historicalBookings = [];
  const historicalWeighments = [];
  const burnSummary = [];

  const tomorrow = addDays(START_DATE, 1);
  // START_DATE itself can't carry a backfilled day (see the comment on
  // BURN_HISTORY_DAYS) -- only this many days actually get real burn.
  const BACKFILLABLE_DAYS = BURN_HISTORY_DAYS - 1;

  for (const centre of centres) {
    const tomorrowInput = centreDailyInputs.find((d) => d.centreId === centre.id && d.serviceDate === tomorrow);
    const tomorrowCentreDay = centreDays.find((d) => d.centreId === centre.id && d.serviceDate === tomorrow);
    const bagsPerTruck = tomorrowCentreDay.bagsPerTruck;
    const physicalCapacityBags = nonGunnyCapacityBags(tomorrowCentreDay.constraintBreakdown, bagsPerTruck);

    const atRisk = AT_RISK_CENTRE_CODES.has(centre.code);
    // Comfortable margin under the dashboard's 1.5-day alert threshold --
    // packing bookings against a target only approximates it (farmer-sized
    // draws, not exact amounts), so the AT_RISK ceiling stays well clear
    // of 1.5 rather than grazing it -- 1.1 landed too close for some seeds.
    const targetCoverDays = atRisk ? rng.float(0.4, 0.9) : rng.float(3, 9);

    let avgDailyBurn;
    if (atRisk) {
      // Running near, but never over, physical capacity -- the whole
      // reason this centre is at risk is that its stock can't keep up
      // with what it's actually processing, not that it's processing an
      // impossible amount.
      avgDailyBurn = Math.max(200, Math.round(physicalCapacityBags * rng.float(0.85, 1.0)));
      tomorrowInput.gunnyBagsAvailable = Math.max(0, Math.round(avgDailyBurn * targetCoverDays));

      // Keeps the declaration screen, dashboard capacity figure, and
      // gunny-cover figure consistent with the stock just lowered above --
      // only the gunny input changed, so only the engine output for this
      // one day needs recomputing.
      const recomputed = computeDailyCapacity({
        weighingMode: tomorrowInput.weighingMode,
        weighbridgeOperatingMinutes: tomorrowInput.weighbridgeOperatingMinutes,
        weighbridgeAvgCycleMinutes: tomorrowInput.weighbridgeAvgCycleMinutes ?? undefined,
        secondsPerBag: tomorrowInput.secondsPerBag ?? undefined,
        avgBagsPerLot: tomorrowInput.avgBagsPerLot ?? undefined,
        hamaliGangCount: tomorrowInput.hamaliGangCount,
        hamaliBagsPerGangPerDay: tomorrowInput.hamaliBagsPerGangPerDay,
        bagsPerTruck: tomorrowInput.bagsPerTruck,
        gunnyBagsAvailable: tomorrowInput.gunnyBagsAvailable,
        truckEvacuationCapacity: tomorrowInput.truckEvacuationCapacity,
        yardCapacityTonnes: tomorrowInput.yardCapacityTonnes - tomorrowInput.undispatchedTonnes,
        avgTruckLoadTonnes: tomorrowInput.avgTruckLoadTonnes,
        moistureMeterCount: tomorrowInput.moistureMeterCount,
        moistureTestsPerMeterPerDay: tomorrowInput.moistureTestsPerMeterPerDay,
      });
      tomorrowCentreDay.totalCapacity = recomputed.totalCapacity;
      tomorrowCentreDay.walkInReserved = recomputed.walkInReserved;
      tomorrowCentreDay.bookableCapacity = recomputed.bookableCapacity;
      tomorrowCentreDay.bagsCapacity = recomputed.bookableCapacity * bagsPerTruck;
      tomorrowCentreDay.bindingConstraint = recomputed.bindingConstraint;
      tomorrowCentreDay.constraintBreakdown = recomputed.constraints;
    } else {
      avgDailyBurn = Math.min(
        physicalCapacityBags,
        Math.max(200, Math.round(tomorrowInput.gunnyBagsAvailable / targetCoverDays))
      );
    }
    const gunnyTomorrow = tomorrowInput.gunnyBagsAvailable;

    // dashboardService.computeBurnRate divides by the full
    // BURN_HISTORY_DAYS no matter how many of those days actually have
    // rows (see the comment on BURN_HISTORY_DAYS) -- scale each
    // backfilled day up so BACKFILLABLE_DAYS days of real burn, averaged
    // over BURN_HISTORY_DAYS, still lands on avgDailyBurn live, not
    // BACKFILLABLE_DAYS/BURN_HISTORY_DAYS of it. Still never above
    // physical capacity for a single day, even after that scale-up.
    const perBackfilledDayTarget = Math.min(
      physicalCapacityBags,
      Math.round((avgDailyBurn * BURN_HISTORY_DAYS) / BACKFILLABLE_DAYS)
    );

    let totalBurned = 0;

    for (let dayOffset = BACKFILLABLE_DAYS; dayOffset >= 1; dayOffset--) {
      const serviceDate = addDays(START_DATE, -dayOffset);
      const dailyTarget = Math.min(physicalCapacityBags, jitterInt(rng, perBackfilledDayTarget, 0.15));
      const centreDayId = uuid();

      let remainingTarget = dailyTarget;
      let sequence = 0;
      let dayBurned = 0;

      while (cursor < candidates.length && remainingTarget > dailyTarget * 0.05) {
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
        bagsPerTruck,
        totalCapacity: Math.ceil(dayBurned / bagsPerTruck),
        walkInReserved: 0,
        bookableCapacity: Math.ceil(dayBurned / bagsPerTruck),
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

async function writeToDatabase({ centres, centreDailyInputs, centreDays, landRecords, farmers, bookings, weighments, employees }) {
  const { Client } = require('pg');
  const client = new Client();
  await client.connect();

  try {
    await client.query('BEGIN');

    // Makes the seed idempotent -- re-running it (e.g. after CENTRES grew,
    // or just to refresh service dates onto the real "today") otherwise
    // dies on the first INSERT with a duplicate key on centres_code_key,
    // since every centre code is fixed and ids are freshly generated each
    // run. CASCADE clears every table that hangs off centres/land_records/
    // farmers/employees transitively (centre_daily_inputs, centre_day,
    // bookings, lot_weighments, and anything created by exercising the
    // live app against a prior seed run, like j_forms) so nothing is left
    // pointing at a row this run is about to replace.
    await client.query('TRUNCATE TABLE centres, land_records, farmers, employees CASCADE');

    await batchInsert(
      client,
      'centres',
      ['id', 'name', 'name_hi', 'name_te', 'code', 'centre_type', 'district', 'state', 'latitude', 'longitude'],
      centres,
      (c) => [c.id, c.name, c.nameHi, c.nameTe, c.code, c.centreType, DISTRICT, STATE, c.lat, c.lng]
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

    await batchInsert(
      client,
      'employees',
      ['id', 'employee_id', 'password_hash', 'name', 'role', 'centre_id', 'district'],
      employees,
      (e) => [e.id, e.employeeId, e.passwordHash, e.name, e.role, e.centreId, e.district]
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

function printSummary({
  centres,
  centreDays,
  landRecords,
  farmers,
  bookings,
  overDeclaredCount,
  burnSummary,
  employees,
  overbookingSummary,
  noShowBookings,
}) {
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

  line(`\nBurn history backfill (${BURN_HISTORY_DAYS - 1} real days, averaged over a ${BURN_HISTORY_DAYS}-day window ending ${START_DATE}, matching the live dashboard), for the district dashboard's gunny cover:`);
  for (const b of burnSummary) {
    const flag = b.daysOfCover !== null && b.daysOfCover < 1.5 ? '  [AT RISK]' : '';
    line(`    ${b.centreName.padEnd(24)} avg burn: ${String(b.avgDailyBurn).padStart(6)} bags/day   gunny (${addDays(START_DATE, 1)}): ${String(b.gunnyTomorrow).padStart(6)}   days of cover: ${b.daysOfCover}${flag}`);
  }

  line(`\nDeliberately overbooked for tomorrow (${addDays(START_DATE, 1)}), for the nightly reallocation job to defer:`);
  for (const o of overbookingSummary) {
    line(
      `    ${o.centreName.padEnd(24)} booked: ${String(o.bagsBooked).padStart(8)} bags   declared capacity cut ${String(o.originalBagsCapacity).padStart(8)} -> ${String(round(o.cutBagsCapacity, 2)).padStart(8)} bags`
    );
  }

  line(`\nNo-shows seeded for today (${START_DATE}), for the nightly job to release: ${noShowBookings.length}`);

  line('\nDemo employee logins (password: demo1234):');
  for (const e of employees) {
    line(`    ${e.employeeId.padEnd(8)} ${e.role.padEnd(17)} ${e.name}`);
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
    centreDays,
    farmers
  );
  const { bookings, overDeclaredCount } = buildBookings(rng, centreDays, farmers);
  const overbookingSummary = applyOverbookingScenario(rng, centres, centreDailyInputs, centreDays);
  const noShowBookings = applyNoShowScenario(rng, bookings, centreDays, NO_SHOW_COUNT);
  const employees = await buildEmployees(centres);

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
      employees,
    });
  }

  printSummary({
    centres,
    centreDays,
    landRecords,
    farmers,
    bookings,
    overDeclaredCount,
    burnSummary,
    employees,
    overbookingSummary,
    noShowBookings,
  });
}

main().catch((err) => {
  console.error('Seed failed:', err.message || err.code || err);
  if (!DRY_RUN) {
    console.error('Make sure db/migrations/001_init_schema.sql has been applied and DATABASE_URL (or PGHOST/PGUSER/...) points at it.');
  }
  process.exitCode = 1;
});
