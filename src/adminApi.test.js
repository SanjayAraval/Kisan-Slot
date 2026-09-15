'use strict';

const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertCentreDay,
  insertDailyInputs,
  insertFarmerWithLand,
  insertBooking,
} = require('./testUtils/fixtures');
const { districtOfficerAgent, centreOfficerAgent, operatorAgent, farmerAgent } = require('./testUtils/authTestHelpers');

const TODAY = '2026-09-04';
const TOMORROW = '2026-09-05';

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  return { pool, app };
}

describe('POST /api/admin/run-reallocation', () => {
  test('refuses anyone but a district officer', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const farmerId = await insertFarmerWithLand(pool, {});

    const asCentre = centreOfficerAgent(app, centreId);
    const asOperator = operatorAgent(app, centreId);
    const asFarmer = farmerAgent(app, farmerId);

    for (const agent of [asCentre, asOperator, asFarmer]) {
      const res = await agent.post('/api/admin/run-reallocation').send({ date: TODAY });
      expect(res.status).toBe(403);
    }
  });

  test('401s when not logged in at all', async () => {
    const { app } = setup();
    const request = require('supertest');
    const res = await request(app).post('/api/admin/run-reallocation').send({ date: TODAY });
    expect(res.status).toBe(401);
  });

  test('400s without a valid date', async () => {
    const { app, pool } = setup();
    const agent = districtOfficerAgent(app);
    const missing = await agent.post('/api/admin/run-reallocation').send({});
    expect(missing.status).toBe(400);
    const malformed = await agent.post('/api/admin/run-reallocation').send({ date: '04-09-2026' });
    expect(malformed.status).toBe(400);
  });

  test('runs the real reallocation and returns a legible plan -- names, scores, and an alternative per deferral', async () => {
    const { app, pool } = setup();
    const agent = districtOfficerAgent(app); // district 'Medak', matches insertCentre's default
    const centreId = await insertCentre(pool, { code: 'MDK-01' });
    // A second, nearby centre with room -- so the deferred farmer's
    // alternative isn't empty.
    const nearbyCentreId = await insertCentre(pool, { code: 'MDK-02', lat: 18.01, lng: 78.01 });
    await insertDailyInputs(pool, { centreId: nearbyCentreId, serviceDate: TOMORROW });

    const centreDayId = await insertCentreDay(pool, {
      centreId,
      serviceDate: TOMORROW,
      bagsCapacity: 800,
      bagsBooked: 600,
    });

    const bigFarmerId = await insertFarmerWithLand(pool, { extentAcres: 10, farmerName: 'Big Farmer' });
    await insertBooking(pool, {
      centreDayId,
      farmerId: bigFarmerId,
      bagsReserved: 200,
      declaredQuantityQuintals: 10 * 24,
      status: 'booked',
      bookedAt: '2026-09-01T00:00:00Z',
    });
    for (let i = 0; i < 4; i++) {
      const smallFarmerId = await insertFarmerWithLand(pool, { extentAcres: 1, farmerName: `Small Farmer ${i}` });
      await insertBooking(pool, {
        centreDayId,
        farmerId: smallFarmerId,
        bagsReserved: 100,
        declaredQuantityQuintals: 24,
        status: 'booked',
        bookedAt: '2026-09-01T00:00:00Z',
      });
    }

    // Tomorrow's declared capacity drops to 400 bags -- 200 short of the
    // 600 already booked, so exactly the big farmer's 200-bag booking gets
    // deferred (protected small-holders otherwise).
    await insertDailyInputs(pool, {
      centreId,
      serviceDate: TOMORROW,
      overrides: { truckEvacuationCapacity: 5 },
    });

    const res = await agent.post('/api/admin/run-reallocation').send({ date: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');

    expect(res.body.centreDayUpserts.length).toBeGreaterThan(0);
    expect(res.body.centreDayUpserts.some((u) => u.centreId === centreId && u.bagsCapacity === 400)).toBe(true);

    expect(res.body.deferrals).toHaveLength(1);
    const deferral = res.body.deferrals[0];
    expect(deferral.farmerId).toBe(bigFarmerId);
    expect(deferral.farmerName).toBe('Big Farmer');
    expect(deferral.centreId).toBe(centreId);
    expect(deferral.centreCode).toBe('MDK-01');
    expect(typeof deferral.score).toBe('number');
    expect(deferral.reason).toBe('capacity_reduced');
    expect(deferral.alternative).toBeTruthy();
    expect(deferral.alternative.nearbyCentres.some((c) => c.centreId === nearbyCentreId)).toBe(true);

    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].farmerName).toBe('Big Farmer');
    expect(res.body.notifications[0].body).toMatch(/deferred/i);

    // The run actually happened, not just a dry preview.
    const deferredRows = await pool.query("SELECT id FROM bookings WHERE status = 'deferred'");
    expect(deferredRows.rowCount).toBe(1);
  });
});

describe('GET /api/admin/messages', () => {
  test('refuses anyone but a district officer', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await centreOfficerAgent(app, centreId).get('/api/admin/messages');
    expect(res.status).toBe(403);
  });

  test('lists queued notifications with the farmer name resolved', async () => {
    const { app, pool } = setup();
    const agent = districtOfficerAgent(app);
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: TODAY, bagsCapacity: 100, bagsBooked: 100 });
    const farmerId = await insertFarmerWithLand(pool, { farmerName: 'Notified Farmer' });
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, status: 'booked' });
    await pool.query(
      `INSERT INTO messages (id, farmer_id, related_booking_id, channel, body)
       VALUES ('11111111-1111-1111-1111-111111111111', $1, $2, 'sms', 'Test notice')`,
      [farmerId, bookingId]
    );

    const res = await agent.get('/api/admin/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThan(0);
    const msg = res.body.messages.find((m) => m.id === '11111111-1111-1111-1111-111111111111');
    expect(msg.farmerName).toBe('Notified Farmer');
    expect(msg.channel).toBe('sms');
    expect(msg.body).toBe('Test notice');
  });
});
