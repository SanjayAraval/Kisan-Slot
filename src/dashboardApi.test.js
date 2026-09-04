'use strict';

const request = require('supertest');
const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertDailyInputs,
  insertCentreDay,
  insertBooking,
  insertFarmerWithLand,
  insertLotWeighment,
  DAILY_INPUT_BASELINE,
} = require('./testUtils/fixtures');

const DATE = '2026-09-06'; // dashboard date
const BURN_DAYS = ['2026-09-03', '2026-09-04', '2026-09-05']; // the 3 days before DATE

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  return { pool, app };
}

// Backs one day of the 3-day burn-rate window with a completed lot that
// consumed `netKg` (-> Math.round(netKg / 40) bags, same as lotService's
// real draw-down) for `centreId`.
async function insertBurnDay(pool, { centreId, serviceDate, netKg }) {
  const centreDayId = await insertCentreDay(pool, { centreId, serviceDate });
  const farmerId = await insertFarmerWithLand(pool, {});
  const bookingId = await insertBooking(pool, { centreDayId, farmerId, status: 'completed' });
  await insertLotWeighment(pool, { bookingId, netKg, grossKg: netKg, tareKg: 0 });
}

describe('GET /api/dashboard', () => {
  test('400s without a date', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(400);
  });

  test('summary, centre grid (sorted by urgency), alerts, and evacuation backlog', async () => {
    const { app, pool } = setup();

    // Centre A: thin gunny stock (100) against a steady burn rate of
    // 100 bags/day -> 1.0 days of cover, under the 1.5-day threshold.
    const centreA = await insertCentre(pool, { name: 'A Centre', code: 'A-01' });
    await insertDailyInputs(pool, { centreId: centreA, serviceDate: DATE, overrides: { gunnyBagsAvailable: 100 } });
    for (const day of BURN_DAYS) {
      await insertBurnDay(pool, { centreId: centreA, serviceDate: day, netKg: 4000 }); // 100 bags/day
    }

    // Centre B: ample gunny stock, no burn history at all -- unknown
    // cover, must NOT be flagged at risk.
    const centreB = await insertCentre(pool, { name: 'B Centre', code: 'B-01' });
    await insertDailyInputs(pool, { centreId: centreB, serviceDate: DATE });

    // Centre C: ample gunny stock but fully subscribed (bags_booked ==
    // bags_capacity) -- overbooked regardless of bag cover.
    const centreC = await insertCentre(pool, { name: 'C Centre', code: 'C-01' });
    await insertDailyInputs(pool, { centreId: centreC, serviceDate: DATE });
    // baseline bookable capacity: 60 total, 12 walk-in reserved -> 48
    // bookable slots * 100 bags/truck = 4800 bags_capacity.
    const centreDayC = await insertCentreDay(pool, {
      centreId: centreC,
      serviceDate: DATE,
      bagsCapacity: 4800,
      bagsBooked: 4800,
    });
    const farmerC = await insertFarmerWithLand(pool, {});
    await insertBooking(pool, { centreDayId: centreDayC, farmerId: farmerC, status: 'booked' });

    const res = await request(app).get('/api/dashboard').query({ date: DATE });
    expect(res.status).toBe(200);

    expect(res.body.summary).toEqual({
      centresOperating: 3,
      totalDistrictCapacity: 1 + 60 + 60, // A binds on gunny (100/100), B and C at baseline 60
      bookingsForDate: 1,
      centresAtRisk: 2, // A (low cover) and C (overbooked)
    });

    // Urgency order: overbooked first, then ascending days of cover,
    // unknown cover (B) last.
    expect(res.body.centres.map((c) => c.code)).toEqual(['C-01', 'A-01', 'B-01']);

    const rowA = res.body.centres.find((c) => c.code === 'A-01');
    expect(rowA.daysOfCover).toBe(1);
    expect(rowA.burnRatePerDay).toBe(100);
    expect(rowA.atRisk).toBe(true);
    expect(rowA.overbooked).toBe(false);

    const rowB = res.body.centres.find((c) => c.code === 'B-01');
    expect(rowB.daysOfCover).toBeNull();
    expect(rowB.atRisk).toBe(false);

    const rowC = res.body.centres.find((c) => c.code === 'C-01');
    expect(rowC.overbooked).toBe(true);
    expect(rowC.atRisk).toBe(true);

    expect(res.body.alerts).toHaveLength(2);
    expect(res.body.alerts.map((a) => a.code).sort()).toEqual(['A-01', 'C-01']);
    const alertA = res.body.alerts.find((a) => a.code === 'A-01');
    expect(alertA.reason).toBe('low_bag_cover');
    const alertC = res.body.alerts.find((a) => a.code === 'C-01');
    expect(alertC.reason).toBe('overbooked');

    expect(res.body.evacuationBacklog).toHaveLength(3);
    expect(res.body.evacuationBacklog[0]).toHaveProperty('yardUtilization');
  });
});

describe('POST /api/dashboard/centres/:id/release-bags', () => {
  test('adds bags to the declaration and recomputes capacity', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE, overrides: { gunnyBagsAvailable: 100 } });

    const res = await request(app)
      .post(`/api/dashboard/centres/${centreId}/release-bags`)
      .send({ date: DATE, additionalBags: 400 });

    expect(res.status).toBe(200);
    expect(res.body.gunnyBagsAvailable).toBe(500);
    expect(res.body.bindingConstraint).toBe('gunny');
    expect(res.body.totalCapacity).toBe(5); // 500 / bagsPerTruck(100)

    const stored = await pool.query('SELECT gunny_bags_available FROM centre_daily_inputs WHERE centre_id = $1 AND service_date = $2', [
      centreId,
      DATE,
    ]);
    expect(Number(stored.rows[0].gunny_bags_available)).toBe(500);
  });

  test('404s when the centre has no declaration on file for that date', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await request(app)
      .post(`/api/dashboard/centres/${centreId}/release-bags`)
      .send({ date: DATE, additionalBags: 100 });

    expect(res.status).toBe(404);
  });

  test('400s on a non-positive additionalBags', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });

    const res = await request(app)
      .post(`/api/dashboard/centres/${centreId}/release-bags`)
      .send({ date: DATE, additionalBags: 0 });

    expect(res.status).toBe(400);
  });
});

// Sanity check that DAILY_INPUT_BASELINE still matches the assumptions
// baked into the test above (60/day on every constraint but gunny, 100
// bags/truck) -- if this ever fails, the dashboard test's hand-computed
// expectations need updating too.
test('fixture baseline assumption', () => {
  expect(DAILY_INPUT_BASELINE.bagsPerTruck).toBe(100);
});
