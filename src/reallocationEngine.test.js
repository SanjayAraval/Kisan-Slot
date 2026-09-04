'use strict';

const {
  planNightlyReallocation,
  computeAllocationScore,
  smallholderPriority,
  lotSizeDeviationRatio,
  selectDeferrals,
  averageServiceMinutes,
  updateEwma,
} = require('./reallocationEngine');

const BASE_FACTORS = { daysWaiting: 10, extentAcres: 3, priorDeferrals: 1, distanceKm: 5, lotSizeDeviationRatio: 0 };

describe('smallholderPriority', () => {
  test('smaller farms get more priority; farms at/above the reference get none', () => {
    expect(smallholderPriority(0)).toBe(5);
    expect(smallholderPriority(2)).toBe(3);
    expect(smallholderPriority(5)).toBe(0);
    expect(smallholderPriority(10)).toBe(0);
  });
});

describe('lotSizeDeviationRatio', () => {
  test('0 when declared exactly matches the land estimate', () => {
    // 2 acres * 24 q/acre = 48q estimate
    expect(lotSizeDeviationRatio(48, 2)).toBe(0);
  });

  test('positive ratio when declared diverges from the estimate', () => {
    expect(lotSizeDeviationRatio(60, 2)).toBeCloseTo(0.25, 5); // (60-48)/48
    expect(lotSizeDeviationRatio(24, 2)).toBeCloseTo(0.5, 5); // (24-48)/48, abs
  });
});

describe('computeAllocationScore', () => {
  test('more days waiting increases the score (protects longer-waiting bookings)', () => {
    const low = computeAllocationScore({ ...BASE_FACTORS, daysWaiting: 1 });
    const high = computeAllocationScore({ ...BASE_FACTORS, daysWaiting: 20 });
    expect(high).toBeGreaterThan(low);
  });

  test('smaller landholding increases the score (smallholder priority)', () => {
    const smallholder = computeAllocationScore({ ...BASE_FACTORS, extentAcres: 0.5 });
    const largeFarm = computeAllocationScore({ ...BASE_FACTORS, extentAcres: 8 });
    expect(smallholder).toBeGreaterThan(largeFarm);
  });

  test('more prior deferrals increases the score (anti-starvation)', () => {
    const neverDeferred = computeAllocationScore({ ...BASE_FACTORS, priorDeferrals: 0 });
    const deferredBefore = computeAllocationScore({ ...BASE_FACTORS, priorDeferrals: 4 });
    expect(deferredBefore).toBeGreaterThan(neverDeferred);
  });

  test('more distance decreases the score', () => {
    const near = computeAllocationScore({ ...BASE_FACTORS, distanceKm: 0 });
    const far = computeAllocationScore({ ...BASE_FACTORS, distanceKm: 30 });
    expect(far).toBeLessThan(near);
  });

  test('more lot-size deviation decreases the score', () => {
    const onTarget = computeAllocationScore({ ...BASE_FACTORS, lotSizeDeviationRatio: 0 });
    const wildlyOff = computeAllocationScore({ ...BASE_FACTORS, lotSizeDeviationRatio: 1 });
    expect(wildlyOff).toBeLessThan(onTarget);
  });
});

describe('selectDeferrals', () => {
  test('defers exactly enough of the lowest-scored bookings to fit capacity', () => {
    const bookings = [
      { bookingId: 'a', bagsReserved: 100, score: 50, bookedAt: '2026-09-01T00:00:00Z' },
      { bookingId: 'b', bagsReserved: 100, score: 10, bookedAt: '2026-09-01T00:00:00Z' }, // lowest
      { bookingId: 'c', bagsReserved: 100, score: 80, bookedAt: '2026-09-01T00:00:00Z' },
      { bookingId: 'd', bagsReserved: 100, score: 30, bookedAt: '2026-09-01T00:00:00Z' }, // 2nd lowest
    ];
    // total 400, capacity 250 -> must drop to <=250 -> defer b (300 left), then d (200 left)
    const deferred = selectDeferrals(bookings, 250);
    expect(deferred.map((b) => b.bookingId)).toEqual(['b', 'd']);
  });

  test('defers nothing when everything already fits', () => {
    const bookings = [{ bookingId: 'a', bagsReserved: 100, score: 1, bookedAt: '2026-09-01T00:00:00Z' }];
    expect(selectDeferrals(bookings, 500)).toEqual([]);
  });

  test('ties break by earliest booked_at, then bookingId', () => {
    const bookings = [
      { bookingId: 'later', bagsReserved: 100, score: 5, bookedAt: '2026-09-02T00:00:00Z' },
      { bookingId: 'earlier', bagsReserved: 100, score: 5, bookedAt: '2026-09-01T00:00:00Z' },
    ];
    // capacity for only one -> the earlier booking is protected, "later" (tie, booked after) goes first
    const deferred = selectDeferrals(bookings, 100);
    expect(deferred.map((b) => b.bookingId)).toEqual(['later']);
  });
});

describe('averageServiceMinutes', () => {
  test('averages checked_in -> completed durations', () => {
    const lots = [
      { checkedInAt: '2026-09-04T09:00:00Z', completedAt: '2026-09-04T09:10:00Z' }, // 10 min
      { checkedInAt: '2026-09-04T09:00:00Z', completedAt: '2026-09-04T09:20:00Z' }, // 20 min
    ];
    expect(averageServiceMinutes(lots)).toBe(15);
  });

  test('null when there are no completed lots', () => {
    expect(averageServiceMinutes([])).toBeNull();
  });
});

describe('updateEwma', () => {
  test('seeds with the first observation when there is no prior value', () => {
    expect(updateEwma(null, 12)).toBe(12);
  });

  test('blends toward the new observation by alpha', () => {
    // alpha=0.3: 0.3*20 + 0.7*10 = 13
    expect(updateEwma(10, 20, 0.3)).toBe(13);
  });
});

describe('planNightlyReallocation', () => {
  function futureDateWithCapacity(date, { bookableTrucks, bagsPerTruck, confirmedBookings }) {
    // A capacity engine input where every constraint equals bookableTrucks
    // / 0.8, so the 20% walk-in reserve lands cleanly on bookableTrucks.
    const total = Math.round(bookableTrucks / 0.8);
    return {
      date,
      dailyInputEngineInput: {
        weighbridgeOperatingMinutes: total * 10,
        weighbridgeAvgCycleMinutes: 10,
        hamaliGangCount: total,
        hamaliBagsPerGangPerDay: bagsPerTruck,
        bagsPerTruck,
        gunnyBagsAvailable: total * bagsPerTruck,
        truckEvacuationCapacity: total,
        yardCapacityTonnes: total * 10,
        avgTruckLoadTonnes: 10,
        moistureMeterCount: 10,
        moistureTestsPerMeterPerDay: 1000,
      },
      confirmedBookings,
    };
  }

  test('a capacity drop produces the right deferral count, and the lowest-scored farmers are chosen', () => {
    // Capacity recomputes to exactly 4 bookable trucks (400 bags). 6
    // confirmed bookings of 100 bags each = 600 bags -> 200 over -> defer 2.
    // Every factor is identical across bookings except priorDeferrals,
    // which increases the score -- so the 2 farmers with the FEWEST prior
    // deferrals (least protected) must be the ones bumped.
    const confirmedBookings = [0, 1, 2, 3, 4, 5].map((i) => ({
      bookingId: `booking-${i}`,
      farmerId: `farmer-${i}`,
      bagsReserved: 100,
      bookedAt: '2026-09-01T00:00:00Z',
      extentAcres: 3,
      declaredQuantityQuintals: 3 * 24, // exact match -> 0 deviation
      priorDeferrals: i, // booking-0 has been deferred least often
      distanceKm: 5,
    }));

    const snapshot = {
      today: '2026-09-04',
      centres: [
        {
          centreId: 'centre-1',
          code: 'MDK-APMC-01',
          today: { noShowBookings: [] },
          futureDates: [
            futureDateWithCapacity('2026-09-05', { bookableTrucks: 4, bagsPerTruck: 100, confirmedBookings }),
          ],
          completedLotsToday: [],
          currentEwmaMinutes: null,
        },
      ],
    };

    const plan = planNightlyReallocation(snapshot);

    expect(plan.deferrals).toHaveLength(2);
    expect(plan.deferrals.map((d) => d.bookingId).sort()).toEqual(['booking-0', 'booking-1']);
    expect(plan.deferrals.every((d) => d.date === '2026-09-05' && d.centreId === 'centre-1')).toBe(true);
    expect(plan.deferrals.every((d) => d.reason === 'capacity_reduced')).toBe(true);

    // one notification per deferral, addressed to the deferred farmer
    expect(plan.notifications).toHaveLength(2);
    expect(plan.notifications.map((n) => n.farmerId).sort()).toEqual(['farmer-0', 'farmer-1']);
    expect(plan.notifications[0].body).toMatch(/deferred/i);

    // the recomputed capacity for the day is still reported
    expect(plan.centreDayUpserts).toHaveLength(1);
    expect(plan.centreDayUpserts[0].bagsCapacity).toBe(400);
  });

  test('no deferrals when confirmed bookings fit the recomputed capacity', () => {
    const confirmedBookings = [
      { bookingId: 'x', farmerId: 'f-x', bagsReserved: 100, bookedAt: '2026-09-01T00:00:00Z', extentAcres: 3, declaredQuantityQuintals: 72, priorDeferrals: 0, distanceKm: 0 },
    ];
    const snapshot = {
      today: '2026-09-04',
      centres: [
        {
          centreId: 'centre-1',
          code: 'C1',
          today: { noShowBookings: [] },
          futureDates: [futureDateWithCapacity('2026-09-05', { bookableTrucks: 4, bagsPerTruck: 100, confirmedBookings })],
          completedLotsToday: [],
          currentEwmaMinutes: null,
        },
      ],
    };

    const plan = planNightlyReallocation(snapshot);
    expect(plan.deferrals).toEqual([]);
    expect(plan.notifications).toEqual([]);
    expect(plan.centreDayUpserts).toHaveLength(1);
  });

  test('skips a future date with no operating data instead of throwing', () => {
    const snapshot = {
      today: '2026-09-04',
      centres: [
        {
          centreId: 'centre-1',
          code: 'C1',
          today: { noShowBookings: [] },
          futureDates: [{ date: '2026-09-05', dailyInputEngineInput: null, confirmedBookings: [] }],
          completedLotsToday: [],
          currentEwmaMinutes: null,
        },
      ],
    };
    const plan = planNightlyReallocation(snapshot);
    expect(plan.centreDayUpserts).toEqual([]);
    expect(plan.deferrals).toEqual([]);
  });

  test('releases todays no-show bookings', () => {
    const snapshot = {
      today: '2026-09-04',
      centres: [
        {
          centreId: 'centre-1',
          code: 'C1',
          today: {
            noShowBookings: [
              { bookingId: 'ns-1', bagsReserved: 100 },
              { bookingId: 'ns-2', bagsReserved: 50 },
            ],
          },
          futureDates: [],
          completedLotsToday: [],
          currentEwmaMinutes: null,
        },
      ],
    };
    const plan = planNightlyReallocation(snapshot);
    expect(plan.noShowReleases).toEqual([
      { bookingId: 'ns-1', centreId: 'centre-1', bagsReleased: 100 },
      { bookingId: 'ns-2', centreId: 'centre-1', bagsReleased: 50 },
    ]);
  });

  test('updates the service-time EWMA from todays completed lots', () => {
    const snapshot = {
      today: '2026-09-04',
      centres: [
        {
          centreId: 'centre-1',
          code: 'C1',
          today: { noShowBookings: [] },
          futureDates: [],
          completedLotsToday: [
            { checkedInAt: '2026-09-04T09:00:00Z', completedAt: '2026-09-04T09:12:00Z' }, // 12 min
          ],
          currentEwmaMinutes: 10,
        },
      ],
    };
    const plan = planNightlyReallocation(snapshot);
    // alpha=0.3: 0.3*12 + 0.7*10 = 10.6
    expect(plan.ewmaUpdates).toEqual([{ centreId: 'centre-1', newEwmaMinutes: 10.6 }]);
  });

  test('no EWMA update when there were no completed lots today', () => {
    const snapshot = {
      today: '2026-09-04',
      centres: [
        {
          centreId: 'centre-1',
          code: 'C1',
          today: { noShowBookings: [] },
          futureDates: [],
          completedLotsToday: [],
          currentEwmaMinutes: 10,
        },
      ],
    };
    const plan = planNightlyReallocation(snapshot);
    expect(plan.ewmaUpdates).toEqual([]);
  });
});
