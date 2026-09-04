'use strict';

const { computeDailyCapacity, CONSTRAINT_ORDER } = require('./capacityEngine');

// Baseline where every constraint independently supports exactly 100
// trucks/day, so tests can drop one field down to make it binding without
// fighting the others.
function baseInput(overrides = {}) {
  return {
    weighbridgeOperatingMinutes: 600, // 600 / 6 = 100
    weighbridgeAvgCycleMinutes: 6,
    hamaliGangCount: 10, // 10 * 500 / 50 = 100
    hamaliBagsPerGangPerDay: 500,
    bagsPerTruck: 50,
    gunnyBagsAvailable: 5000, // 5000 / 50 = 100
    truckEvacuationCapacity: 100,
    yardCapacityTonnes: 2500, // 2500 / 25 = 100
    avgTruckLoadTonnes: 25,
    moistureMeterCount: 10, // 10 * 10 = 100
    moistureTestsPerMeterPerDay: 10,
    ...overrides,
  };
}

describe('computeDailyCapacity', () => {
  test('all constraints equal: capacity is that value, first constraint in order wins the tie', () => {
    const result = computeDailyCapacity(baseInput());

    expect(result.totalCapacity).toBe(100);
    expect(result.bindingConstraint).toBe('weighbridge');
    expect(result.bindingConstraints).toEqual(CONSTRAINT_ORDER);
  });

  test.each([
    ['weighbridge', { weighbridgeOperatingMinutes: 60 }, 10], // 60/6
    ['hamali', { hamaliGangCount: 2 }, 20], // 2*500/50
    ['gunny', { gunnyBagsAvailable: 1000 }, 20], // 1000/50
    ['truckEvacuation', { truckEvacuationCapacity: 30 }, 30],
    ['yardSpace', { yardCapacityTonnes: 500 }, 20], // 500/25
    ['moistureTesting', { moistureMeterCount: 2 }, 20], // 2*10
  ])('%s alone binds when it is the smallest constraint', (name, overrides, expectedCapacity) => {
    const result = computeDailyCapacity(baseInput(overrides));

    expect(result.totalCapacity).toBe(expectedCapacity);
    expect(result.bindingConstraint).toBe(name);
    expect(result.bindingConstraints).toEqual([name]);
  });

  test('non-tied constraints are reported in the breakdown even when not binding', () => {
    const result = computeDailyCapacity(baseInput({ gunnyBagsAvailable: 1000 }));

    expect(result.constraints).toEqual({
      weighbridge: 100,
      hamali: 100,
      gunny: 20,
      truckEvacuation: 100,
      yardSpace: 100,
      moistureTesting: 100,
    });
  });

  test('two constraints tied at the minimum both appear in bindingConstraints', () => {
    const result = computeDailyCapacity(
      baseInput({ gunnyBagsAvailable: 1000, truckEvacuationCapacity: 20 })
    );

    expect(result.totalCapacity).toBe(20);
    expect(result.bindingConstraint).toBe('gunny');
    expect(result.bindingConstraints).toEqual(['gunny', 'truckEvacuation']);
  });

  test('fractional constraint capacity is floored, not rounded', () => {
    // 600 / 7 = 85.71...
    const result = computeDailyCapacity(baseInput({ weighbridgeAvgCycleMinutes: 7 }));

    expect(result.constraints.weighbridge).toBe(85);
  });

  test('walk-in reservation is ceil(20%) and bookable capacity is the remainder', () => {
    // 100 * 0.2 = 20 exactly
    const exact = computeDailyCapacity(baseInput());
    expect(exact.walkInReserved).toBe(20);
    expect(exact.bookableCapacity).toBe(80);

    // 7 * 0.2 = 1.4 -> ceil to 2
    const rounded = computeDailyCapacity(baseInput({ truckEvacuationCapacity: 7 }));
    expect(rounded.totalCapacity).toBe(7);
    expect(rounded.walkInReserved).toBe(2);
    expect(rounded.bookableCapacity).toBe(5);
  });

  test('a custom walk-in reserve ratio is honoured', () => {
    const result = computeDailyCapacity(baseInput({ truckEvacuationCapacity: 10 }), 0.5);

    expect(result.totalCapacity).toBe(10);
    expect(result.walkInReserved).toBe(5);
    expect(result.bookableCapacity).toBe(5);
  });

  test('zero capacity on the binding constraint zeroes out the whole day', () => {
    const result = computeDailyCapacity(baseInput({ gunnyBagsAvailable: 0 }));

    expect(result.totalCapacity).toBe(0);
    expect(result.bindingConstraint).toBe('gunny');
    expect(result.walkInReserved).toBe(0);
    expect(result.bookableCapacity).toBe(0);
  });

  test.each([
    ['weighbridgeOperatingMinutes', 0],
    ['weighbridgeAvgCycleMinutes', 0],
    ['bagsPerTruck', 0],
    ['yardCapacityTonnes', 0],
    ['avgTruckLoadTonnes', 0],
    ['hamaliGangCount', -1],
    ['gunnyBagsAvailable', -1],
    ['truckEvacuationCapacity', -1],
    ['moistureMeterCount', -1],
    ['moistureTestsPerMeterPerDay', -1],
  ])('rejects invalid %s = %s', (field, value) => {
    expect(() => computeDailyCapacity(baseInput({ [field]: value }))).toThrow(RangeError);
  });

  test.each([
    ['weighbridgeOperatingMinutes', 'lots'],
    ['hamaliGangCount', undefined],
    ['gunnyBagsAvailable', NaN],
    ['moistureMeterCount', undefined],
  ])('rejects non-numeric %s', (field, value) => {
    expect(() => computeDailyCapacity(baseInput({ [field]: value }))).toThrow(TypeError);
  });

  test('rejects a missing or non-object input', () => {
    expect(() => computeDailyCapacity(null)).toThrow(TypeError);
    expect(() => computeDailyCapacity(undefined)).toThrow(TypeError);
    expect(() => computeDailyCapacity('not an object')).toThrow(TypeError);
  });

  describe('weighingMode', () => {
    test('defaults to weighbridge when omitted', () => {
      const withDefault = computeDailyCapacity(baseInput());
      const explicit = computeDailyCapacity(baseInput({ weighingMode: 'weighbridge' }));

      expect(withDefault.constraints.weighbridge).toBe(explicit.constraints.weighbridge);
    });

    test('platform mode derives cycle time from lot size: operatingMinutes / (secondsPerBag/60 * avgBagsPerLot)', () => {
      const result = computeDailyCapacity(
        baseInput({
          weighingMode: 'platform',
          secondsPerBag: 6,
          avgBagsPerLot: 20,
          // weighbridgeAvgCycleMinutes is irrelevant in platform mode
        })
      );

      // (6/60 * 20) = 2 minutes/lot -> 600/2 = 300
      expect(result.constraints.weighbridge).toBe(300);
    });

    test('a platform centre has lower weighing capacity than a weighbridge centre with identical other inputs', () => {
      const weighbridgeCentre = computeDailyCapacity(
        baseInput({ weighingMode: 'weighbridge', weighbridgeAvgCycleMinutes: 6 })
      );

      // Same 600 operating minutes, but a 60-bag lot at 10s/bag takes
      // 10 min/lot on the platform -- longer than the weighbridge's
      // fixed 6 min/lot cycle -- so throughput drops even though every
      // other input (operating minutes, hamali, gunny, evacuation, yard,
      // moisture) is unchanged.
      const platformCentre = computeDailyCapacity(
        baseInput({ weighingMode: 'platform', secondsPerBag: 10, avgBagsPerLot: 60 })
      );

      expect(platformCentre.constraints.weighbridge).toBeLessThan(weighbridgeCentre.constraints.weighbridge);
      expect(weighbridgeCentre.constraints.weighbridge).toBe(100);
      expect(platformCentre.constraints.weighbridge).toBe(60);
    });

    test('platform mode requires secondsPerBag and avgBagsPerLot, not weighbridgeAvgCycleMinutes', () => {
      const input = baseInput({ weighingMode: 'platform', secondsPerBag: 6, avgBagsPerLot: 20 });
      delete input.weighbridgeAvgCycleMinutes;

      expect(() => computeDailyCapacity(input)).not.toThrow();
    });

    test.each([
      ['secondsPerBag', 0],
      ['avgBagsPerLot', 0],
    ])('platform mode rejects invalid %s = %s', (field, value) => {
      expect(() =>
        computeDailyCapacity(baseInput({ weighingMode: 'platform', secondsPerBag: 6, avgBagsPerLot: 20, [field]: value }))
      ).toThrow(RangeError);
    });

    test('rejects an unknown weighingMode', () => {
      expect(() => computeDailyCapacity(baseInput({ weighingMode: 'manual' }))).toThrow(RangeError);
    });
  });

  describe('moistureTesting', () => {
    test('is computed as meterCount * testsPerMeterPerDay', () => {
      const result = computeDailyCapacity(
        baseInput({ moistureMeterCount: 3, moistureTestsPerMeterPerDay: 40 })
      );

      expect(result.constraints.moistureTesting).toBe(120);
    });

    test('effectively never binds: realistic moisture testing throughput dwarfs every other constraint', () => {
      // A handful of moisture meters can test far more lots per day than
      // a centre could ever physically weigh, gang-handle, stock in
      // gunny, evacuate, or yard -- so in practice it never ends up as
      // the binding constraint.
      const result = computeDailyCapacity(
        baseInput({ moistureMeterCount: 5, moistureTestsPerMeterPerDay: 200 })
      );

      expect(result.constraints.moistureTesting).toBe(1000);
      expect(result.bindingConstraint).not.toBe('moistureTesting');
      expect(result.bindingConstraints).not.toContain('moistureTesting');
    });
  });
});
