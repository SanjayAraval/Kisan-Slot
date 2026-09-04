'use strict';

// A slot is a promise about capacity. Daily capacity is derived as
// min() across independent constraints -- never a fixed number.
// See CLAUDE.md.

const WALK_IN_RESERVE_RATIO = 0.2;

const WEIGHING_MODES = ['weighbridge', 'platform'];
const DEFAULT_WEIGHING_MODE = 'weighbridge';

// Order determines which constraint is reported as *the* binding one
// when two or more tie at the minimum. Earlier in the queue wins.
const CONSTRAINT_ORDER = ['weighbridge', 'hamali', 'gunny', 'truckEvacuation', 'yardSpace', 'moistureTesting'];

const BASE_REQUIRED_FIELDS = {
  weighbridgeOperatingMinutes: 'positive',
  hamaliGangCount: 'nonNegative',
  hamaliBagsPerGangPerDay: 'nonNegative',
  bagsPerTruck: 'positive',
  gunnyBagsAvailable: 'nonNegative',
  truckEvacuationCapacity: 'nonNegative',
  yardCapacityTonnes: 'positive',
  avgTruckLoadTonnes: 'positive',
  moistureMeterCount: 'nonNegative',
  moistureTestsPerMeterPerDay: 'nonNegative',
};

// Fields required on top of BASE_REQUIRED_FIELDS, depending on weighingMode.
const MODE_REQUIRED_FIELDS = {
  weighbridge: { weighbridgeAvgCycleMinutes: 'positive' },
  platform: { secondsPerBag: 'positive', avgBagsPerLot: 'positive' },
};

function resolveWeighingMode(input) {
  const mode = input.weighingMode === undefined ? DEFAULT_WEIGHING_MODE : input.weighingMode;

  if (!WEIGHING_MODES.includes(mode)) {
    throw new RangeError(`weighingMode must be one of ${WEIGHING_MODES.join(', ')}`);
  }

  return mode;
}

function validateInput(input, weighingMode) {
  const requiredFields = { ...BASE_REQUIRED_FIELDS, ...MODE_REQUIRED_FIELDS[weighingMode] };

  for (const [field, rule] of Object.entries(requiredFields)) {
    const value = input[field];

    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError(`${field} must be a number`);
    }
    if (rule === 'positive' && value <= 0) {
      throw new RangeError(`${field} must be greater than 0`);
    }
    if (rule === 'nonNegative' && value < 0) {
      throw new RangeError(`${field} must be 0 or greater`);
    }
  }
}

/**
 * Minutes needed to weigh one lot. Weighbridge has a fixed per-lot cycle
 * time. Platform weighing is per-bag, so it scales with lot size -- a
 * bigger lot takes proportionally longer.
 */
function weighingMinutesPerLot(input, weighingMode) {
  if (weighingMode === 'platform') {
    return (input.secondsPerBag / 60) * input.avgBagsPerLot;
  }
  return input.weighbridgeAvgCycleMinutes;
}

/**
 * Computes the number of trucks/slots each constraint can support in a day.
 * Each figure is floored -- a fraction of a truck cycle doesn't count.
 */
function computeConstraints(input, weighingMode) {
  const minutesPerLot = weighingMinutesPerLot(input, weighingMode);

  return {
    weighbridge: Math.floor(input.weighbridgeOperatingMinutes / minutesPerLot),
    hamali: Math.floor((input.hamaliGangCount * input.hamaliBagsPerGangPerDay) / input.bagsPerTruck),
    gunny: Math.floor(input.gunnyBagsAvailable / input.bagsPerTruck),
    truckEvacuation: Math.floor(input.truckEvacuationCapacity),
    yardSpace: Math.floor(input.yardCapacityTonnes / input.avgTruckLoadTonnes),
    moistureTesting: Math.floor(input.moistureMeterCount * input.moistureTestsPerMeterPerDay),
  };
}

/**
 * Derives a centre's daily slot capacity from its operational constraints
 * and reports which constraint is binding.
 *
 * @param {object} input - matches the shape of a centre_daily_inputs row
 *   (camelCase), plus:
 *   - weighingMode: 'weighbridge' | 'platform' (default 'weighbridge').
 *     'weighbridge' uses weighbridgeAvgCycleMinutes as a fixed per-lot
 *     cycle time. 'platform' instead requires secondsPerBag and
 *     avgBagsPerLot, and derives per-lot time from lot size.
 *   - moistureMeterCount, moistureTestsPerMeterPerDay: feed the
 *     moistureTesting constraint.
 *   See BASE_REQUIRED_FIELDS / MODE_REQUIRED_FIELDS for the full field list.
 * @param {number} [walkInReserveRatio=0.2] - fraction of total capacity
 *   reserved for walk-ins.
 * @returns {{
 *   constraints: Record<string, number>,
 *   totalCapacity: number,
 *   bindingConstraint: string,
 *   bindingConstraints: string[],
 *   walkInReserved: number,
 *   bookableCapacity: number,
 * }}
 */
function computeDailyCapacity(input, walkInReserveRatio = WALK_IN_RESERVE_RATIO) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('capacity engine input must be an object');
  }

  const weighingMode = resolveWeighingMode(input);
  validateInput(input, weighingMode);

  const constraints = computeConstraints(input, weighingMode);
  const totalCapacity = Math.min(...CONSTRAINT_ORDER.map((key) => constraints[key]));

  const bindingConstraints = CONSTRAINT_ORDER.filter((key) => constraints[key] === totalCapacity);
  const bindingConstraint = bindingConstraints[0];

  const walkInReserved = Math.ceil(totalCapacity * walkInReserveRatio);
  const bookableCapacity = totalCapacity - walkInReserved;

  return {
    constraints,
    totalCapacity,
    bindingConstraint,
    bindingConstraints,
    walkInReserved,
    bookableCapacity,
  };
}

module.exports = {
  computeDailyCapacity,
  WALK_IN_RESERVE_RATIO,
  CONSTRAINT_ORDER,
};
