'use strict';

const request = require('supertest');
const { createApp, todayInIST } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertDailyInputs,
  insertFarmer,
  insertFarmerWithLand,
} = require('./testUtils/fixtures');
const { operatorAgent } = require('./testUtils/authTestHelpers');

const DATE = '2026-09-04';
const NEXT_DATE = '2026-09-05';

function setup() {
  const pool = createTestPool();
  // Fixes "today" at DATE so these fixtures stay valid regardless of the
  // real wall-clock date -- see the past-date rejection test below for the
  // one case that cares about the boundary itself.
  const app = createApp(pool, { now: () => DATE });
  // Operator: allowed to book on behalf of any farmer, no centre
  // restriction -- lets every existing fixture-driven test keep using
  // whatever farmerId/centreId it creates without per-test auth wiring.
  const agent = operatorAgent(app);
  return { pool, app, agent };
}

describe('POST /api/bookings', () => {
  test('400s on missing/invalid fields', async () => {
    const { app, agent } = setup();
    const res = await agent.post('/api/bookings').send({ quintals: 10 });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('BAD_REQUEST');
  });

  test('date before today is rejected with a clear error, not booked', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: '2026-09-03' });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const res = await agent
      .post('/api/bookings')
      .send({ farmerId, quintals: 10, centreId, date: '2026-09-03' }); // one day before DATE ("today")

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('BAD_REQUEST');
    expect(res.body.errors.some((e) => /past/i.test(e))).toBe(true);

    const bookings = await pool.query('SELECT * FROM bookings');
    expect(bookings.rowCount).toBe(0);
  });

  test('malformed (non-uuid) farmerId or centreId is a 400, not a raw DB 500', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const badFarmer = await agent
      .post('/api/bookings')
      .send({ farmerId: 'not-a-uuid', quintals: 10, centreId, date: DATE });
    expect(badFarmer.status).toBe(400);
    expect(badFarmer.body.status).toBe('BAD_REQUEST');

    const badCentre = await agent
      .post('/api/bookings')
      .send({ farmerId, quintals: 10, centreId: 'not-a-uuid', date: DATE });
    expect(badCentre.status).toBe(400);
    expect(badCentre.body.status).toBe('BAD_REQUEST');
  });

  test('same farmer booking twice for the same centre and date is rejected, not a raw DB 500', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE }); // baseline: plenty of room
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const first = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });
    expect(first.status).toBe(201);

    const second = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe('ALREADY_BOOKED');

    const bookings = await pool.query('SELECT * FROM bookings WHERE farmer_id = $1', [farmerId]);
    expect(bookings.rowCount).toBe(1); // the duplicate attempt left no trace
  });

  test('unknown farmer returns 404, not a review flag', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });

    const res = await agent
      .post('/api/bookings')
      .send({ farmerId: '00000000-0000-0000-0000-000000000000', quintals: 10, centreId, date: DATE });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('NOT_FOUND');
  });

  test('unknown centre (valid uuid, no such centre) returns 404, not a raw DB 500', async () => {
    const { app, agent, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const res = await agent
      .post('/api/bookings')
      .send({ farmerId, quintals: 10, centreId: '00000000-0000-0000-0000-000000000000', date: DATE });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('NOT_FOUND');
  });

  test('quantity of zero, negative or non-numeric is a 400, not booked', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const zero = await agent.post('/api/bookings').send({ farmerId, quintals: 0, centreId, date: DATE });
    expect(zero.status).toBe(400);

    const negative = await agent.post('/api/bookings').send({ farmerId, quintals: -5, centreId, date: DATE });
    expect(negative.status).toBe(400);

    const nonNumeric = await agent.post('/api/bookings').send({ farmerId, quintals: 'forty', centreId, date: DATE });
    expect(nonNumeric.status).toBe(400);
  });

  test('quantity above the absolute 5000q cap is rejected even for a large land record', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 500 }); // land estimate 12000q -- well above 5000

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 5001, centreId, date: DATE });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => /5000/.test(e))).toBe(true);
  });

  test('date more than 7 days ahead is rejected server-side even if the client sends one anyway', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });
    const tooFar = '2026-09-12'; // DATE ("today") is 2026-09-04 -- 8 days ahead
    await insertDailyInputs(pool, { centreId, serviceDate: tooFar });

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: tooFar });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => /7 days ahead/.test(e))).toBe(true);

    const bookings = await pool.query('SELECT * FROM bookings');
    expect(bookings.rowCount).toBe(0);
  });

  test('a second active booking for the same farmer and date, at a different centre, is rejected', async () => {
    const { app, agent, pool } = setup();
    const centreA = await insertCentre(pool, { code: 'CENTRE-A' });
    const centreB = await insertCentre(pool, { code: 'CENTRE-B' });
    await insertDailyInputs(pool, { centreId: centreA, serviceDate: DATE });
    await insertDailyInputs(pool, { centreId: centreB, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const first = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId: centreA, date: DATE });
    expect(first.status).toBe(201);

    const second = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId: centreB, date: DATE });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe('ALREADY_BOOKED');

    const bookings = await pool.query('SELECT * FROM bookings WHERE farmer_id = $1', [farmerId]);
    expect(bookings.rowCount).toBe(1); // the second attempt at centre B left no trace
  });

  test('farmer with no land record -> NEEDS_OFFICER_REVIEW, not rejected', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmer(pool, { landRecordId: null });

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NEEDS_OFFICER_REVIEW');
    expect(res.body.reason).toBe('no_land_record');

    const bookings = await pool.query('SELECT * FROM bookings');
    expect(bookings.rowCount).toBe(0);
  });

  test('declared quantity > 1.3x land estimate -> NEEDS_OFFICER_REVIEW, not rejected', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    // 2 acres * 24 q/acre = 48q estimate; cap = 62.4q
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 2 });

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 70, centreId, date: DATE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NEEDS_OFFICER_REVIEW');
    expect(res.body.reason).toBe('quantity_exceeds_estimate');
    expect(res.body.landEstimateQuintals).toBe(48);

    const bookings = await pool.query('SELECT * FROM bookings');
    expect(bookings.rowCount).toBe(0);
  });

  test('centre with no operating data for that date -> 404', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 2 });

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('NOT_FOUND');
  });

  test('booking that fits succeeds: creates a booking, a token, and decrements remaining capacity', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE }); // baseline: bookable=48 trucks, 4800 bags
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 }); // estimate 120q, cap 156q

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 40, centreId, date: DATE });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('BOOKED');
    expect(res.body.booking.token).toMatch(/^TEST-\w+-20260904-0001$/);
    expect(res.body.booking.bagsReserved).toBe(100); // 40 * 2.5
    expect(res.body.remainingBags).toBe(4700); // 4800 - 100

    const dbBooking = await pool.query('SELECT * FROM bookings WHERE farmer_id = $1', [farmerId]);
    expect(dbBooking.rowCount).toBe(1);
    expect(Number(dbBooking.rows[0].bags_reserved)).toBe(100);

    const centreDay = await pool.query('SELECT bags_booked FROM centre_day WHERE centre_id = $1', [centreId]);
    expect(Number(centreDay.rows[0].bags_booked)).toBe(100);
  });

  test('booking that does not fit returns alternatives, not a bare failure', async () => {
    const { app, agent, pool } = setup();
    // Zero bookable capacity today (truck evacuation crushed to 1 -> 20%
    // walk-in reserve rounds the whole day's bookable pool to 0).
    const centreId = await insertCentre(pool, { name: 'Full Centre', code: 'FULL-01', lat: 18.0, lng: 78.0 });
    await insertDailyInputs(pool, { centreId, serviceDate: DATE, overrides: { truckEvacuationCapacity: 1 } });
    // Same centre, next day: plenty of room.
    await insertDailyInputs(pool, { centreId, serviceDate: NEXT_DATE });
    // A nearby centre (within 25km) with room today.
    const nearbyId = await insertCentre(pool, { name: 'Nearby Centre', code: 'NEAR-01', lat: 18.05, lng: 78.05 });
    await insertDailyInputs(pool, { centreId: nearbyId, serviceDate: DATE });
    // A far centre (>25km) with room today -- must NOT show up.
    const farId = await insertCentre(pool, { name: 'Far Centre', code: 'FAR-01', lat: 19.5, lng: 79.5 });
    await insertDailyInputs(pool, { centreId: farId, serviceDate: DATE });

    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const res = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NO_CAPACITY');
    expect(res.body.alternatives).toBeDefined();

    expect(res.body.alternatives.nextDateAtThisCentre.date).toBe(NEXT_DATE);
    expect(res.body.alternatives.nextDateAtThisCentre.remainingSlots).toBeGreaterThan(0);

    const nearbyCodes = res.body.alternatives.nearbyCentres.map((c) => c.code);
    expect(nearbyCodes).toContain('NEAR-01');
    expect(nearbyCodes).not.toContain('FAR-01');

    const bookings = await pool.query('SELECT * FROM bookings');
    expect(bookings.rowCount).toBe(0);
  });

  test('two concurrent bookings for the last slot: exactly one succeeds', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    // truckEvacuationCapacity=2 -> total=2, walk-in reserved=ceil(0.4)=1,
    // bookable=1 truck -> bagsCapacity = 1*100 = 100. A single 40q
    // booking needs exactly 100 bags -- the whole day's pool.
    await insertDailyInputs(pool, { centreId, serviceDate: DATE, overrides: { truckEvacuationCapacity: 2 } });
    const farmerA = await insertFarmerWithLand(pool, { extentAcres: 5, farmerName: 'Farmer A' });
    const farmerB = await insertFarmerWithLand(pool, { extentAcres: 5, farmerName: 'Farmer B' });

    const [resA, resB] = await Promise.all([
      agent.post('/api/bookings').send({ farmerId: farmerA, quintals: 40, centreId, date: DATE }),
      agent.post('/api/bookings').send({ farmerId: farmerB, quintals: 40, centreId, date: DATE }),
    ]);

    const statuses = [resA.body.status, resB.body.status].sort();
    expect(statuses).toEqual(['BOOKED', 'NO_CAPACITY']);

    const bookings = await pool.query('SELECT * FROM bookings');
    expect(bookings.rowCount).toBe(1); // never both

    const centreDay = await pool.query('SELECT bags_booked, bags_capacity FROM centre_day WHERE centre_id = $1', [
      centreId,
    ]);
    expect(Number(centreDay.rows[0].bags_booked)).toBe(100);
    expect(Number(centreDay.rows[0].bags_booked)).toBeLessThanOrEqual(Number(centreDay.rows[0].bags_capacity));
  });
});

describe('todayInIST', () => {
  test('derives "today" from IST, not the host machine\'s local/UTC date', () => {
    // 2026-09-04T20:00:00Z is 2026-09-05 01:30 IST -- the IST calendar day
    // has already rolled over to the 5th even though UTC (and any host
    // machine running in UTC, the common default for a cloud VM) is still
    // on the 4th. A naive `new Date().toISOString().slice(0, 10)` would
    // wrongly report '2026-09-04' here.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-04T20:00:00.000Z').getTime());
    try {
      expect(todayInIST()).toBe('2026-09-05');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('POST /api/bookings, with no `now` override, rejects a date that is "today" in UTC but already past in IST', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-04T20:00:00.000Z').getTime());
    try {
      const pool = createTestPool();
      const app = createApp(pool); // default `now` -- exercises todayInIST for real
      const agent = operatorAgent(app);
      const centreId = await insertCentre(pool);
      await insertDailyInputs(pool, { centreId, serviceDate: '2026-09-04' });
      const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

      const res = await agent
        .post('/api/bookings')
        .send({ farmerId, quintals: 10, centreId, date: '2026-09-04' });

      expect(res.status).toBe(400);
      expect(res.body.errors.some((e) => /past/i.test(e))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('GET /api/centres/:id/availability', () => {
  test('returns capacity, bookable slots, remaining and binding constraint', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE, overrides: { gunnyBagsAvailable: 2000 } }); // gunny=20 -> binds

    const res = await agent.get(`/api/centres/${centreId}/availability`).query({ date: DATE });

    expect(res.status).toBe(200);
    expect(res.body.capacity).toBe(20);
    expect(res.body.bindingConstraint).toBe('gunny');
    expect(res.body.bookableSlots).toBe(20 - Math.ceil(20 * 0.2)); // 16
    expect(res.body.remaining).toBe(res.body.bookableSlots); // nothing booked yet
    expect(res.body.constraints.gunny).toBe(20);
  });

  test('reflects bookings already made against the day', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    await agent.post('/api/bookings').send({ farmerId, quintals: 40, centreId, date: DATE });

    const res = await agent.get(`/api/centres/${centreId}/availability`).query({ date: DATE });
    expect(res.status).toBe(200);
    // baseline bookable = 48 trucks; one 40q (100-bag) booking = 1 truck-equivalent
    expect(res.body.remaining).toBe(res.body.bookableSlots - 1);
  });

  test('404s when the centre has no operating data for that date', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await agent.get(`/api/centres/${centreId}/availability`).query({ date: DATE });
    expect(res.status).toBe(404);
  });

  test('400s without a date query param', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await agent.get(`/api/centres/${centreId}/availability`);
    expect(res.status).toBe(400);
  });
});
