'use strict';

const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertCentreDay,
  insertFarmerWithLand,
  insertBooking,
} = require('./testUtils/fixtures');
const { centreOfficerAgent, districtOfficerAgent, operatorAgent, farmerAgent } = require('./testUtils/authTestHelpers');

const DATE = '2026-09-16';

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  return { pool, app };
}

describe('POST /api/lots/:id/scan', () => {
  test('validates the token, checks the lot in, and joins the queue', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'MDK-01-20260916-001', status: 'booked' });

    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.post(`/api/lots/${bookingId}/scan`).send({ token: 'MDK-01-20260916-001' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.centreId).toBe(centreId);

    const row = await pool.query('SELECT status, checked_in_at FROM bookings WHERE id = $1', [bookingId]);
    expect(row.rows[0].status).toBe('checked_in');
    expect(row.rows[0].checked_in_at).not.toBeNull();
  });

  test('400s a mismatched token, without checking the lot in', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'REAL-TOKEN', status: 'booked' });

    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.post(`/api/lots/${bookingId}/scan`).send({ token: 'WRONG-TOKEN' });

    expect(res.status).toBe(400);
    const row = await pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(row.rows[0].status).toBe('booked');
  });

  test('400s a missing token', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.post(`/api/lots/00000000-0000-0000-0000-000000000000/scan`).send({});
    expect(res.status).toBe(400);
  });

  test('409s a lot that is not in the booked state (e.g. already scanned)', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'TOK-1', status: 'checked_in' });

    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.post(`/api/lots/${bookingId}/scan`).send({ token: 'TOK-1' });

    expect(res.status).toBe(409);
  });

  test('refuses an officer from a different centre', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const otherCentreId = await insertCentre(pool, { code: 'OTHER-01' });
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'TOK-1', status: 'booked' });

    const wrongOfficer = centreOfficerAgent(app, otherCentreId);
    const res = await wrongOfficer.post(`/api/lots/${bookingId}/scan`).send({ token: 'TOK-1' });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/lots/by-token/:token', () => {
  test('resolves a token to its booking for the manual-entry fallback', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool, { name: 'Medak APMC Mandi', code: 'MDK-01' });
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { farmerName: 'Ravi Kumar' });
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'MDK-01-20260916-001', status: 'booked' });

    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.get('/api/lots/by-token/MDK-01-20260916-001');

    expect(res.status).toBe(200);
    expect(res.body.bookingId).toBe(bookingId);
    expect(res.body.farmerName).toBe('Ravi Kumar');
    expect(res.body.centreId).toBe(centreId);
    expect(res.body.status).toBe('booked');
  });

  test('404s an unknown token', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.get('/api/lots/by-token/NO-SUCH-TOKEN');
    expect(res.status).toBe(404);
  });

  test('refuses a farmer or district officer', async () => {
    const { app, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, {});
    const asFarmer = await farmerAgent(app, farmerId).get('/api/lots/by-token/X');
    expect(asFarmer.status).toBe(403);

    const asDistrict = await districtOfficerAgent(app).get('/api/lots/by-token/X');
    expect(asDistrict.status).toBe(403);
  });
});

describe('POST /api/lots/:id/serve', () => {
  test('advances the queue without touching booking status', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, {
      centreDayId,
      farmerId,
      token: 'TOK-1',
      status: 'checked_in',
      checkedInAt: '2026-09-16T06:00:00Z',
    });

    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.post(`/api/lots/${bookingId}/serve`).send();

    expect(res.status).toBe(200);
    const row = await pool.query('SELECT status, queue_served_at FROM bookings WHERE id = $1', [bookingId]);
    expect(row.rows[0].status).toBe('checked_in'); // untouched -- see queueService.markServed
    expect(row.rows[0].queue_served_at).not.toBeNull();
  });

  test('409s a lot that is not checked in', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'TOK-1', status: 'booked' });

    const officer = centreOfficerAgent(app, centreId);
    const res = await officer.post(`/api/lots/${bookingId}/serve`).send();
    expect(res.status).toBe(409);
  });

  test('409s serving the same lot twice', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, {
      centreDayId,
      farmerId,
      token: 'TOK-1',
      status: 'checked_in',
      checkedInAt: '2026-09-16T06:00:00Z',
    });

    const officer = centreOfficerAgent(app, centreId);
    const first = await officer.post(`/api/lots/${bookingId}/serve`).send();
    expect(first.status).toBe(200);
    const second = await officer.post(`/api/lots/${bookingId}/serve`).send();
    expect(second.status).toBe(409);
  });
});

describe('GET /api/centres/:id/queue', () => {
  test('400s without a valid date', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`);
    expect(res.status).toBe(400);
  });

  test('404s an unknown centre', async () => {
    const { app } = setup();
    const res = await require('supertest')(app)
      .get('/api/centres/00000000-0000-0000-0000-000000000000/queue')
      .query({ date: DATE });
    expect(res.status).toBe(404);
  });

  test('is public -- no auth required', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });
    expect(res.status).toBe(200);
  });

  test('an empty queue when nobody has checked in', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });
    expect(res.status).toBe(200);
    expect(res.body.nowServing).toBeNull();
    expect(res.body.waiting).toEqual([]);
  });

  test('orders the queue by check-in time -- first in, now serving; rest waiting in order', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });

    const farmerA = await insertFarmerWithLand(pool, { farmerName: 'Farmer A' });
    const farmerB = await insertFarmerWithLand(pool, { farmerName: 'Farmer B' });
    const farmerC = await insertFarmerWithLand(pool, { farmerName: 'Farmer C' });

    // Inserted out of order -- the queue must sort by checked_in_at, not
    // insertion order.
    await insertBooking(pool, { centreDayId, farmerId: farmerB, token: 'TOK-B', status: 'checked_in', checkedInAt: '2026-09-16T06:10:00Z' });
    await insertBooking(pool, { centreDayId, farmerId: farmerA, token: 'TOK-A', status: 'checked_in', checkedInAt: '2026-09-16T06:00:00Z' });
    await insertBooking(pool, { centreDayId, farmerId: farmerC, token: 'TOK-C', status: 'checked_in', checkedInAt: '2026-09-16T06:20:00Z' });

    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });

    expect(res.status).toBe(200);
    expect(res.body.nowServing.token).toBe('TOK-A');
    expect(res.body.waiting.map((w) => w.token)).toEqual(['TOK-B', 'TOK-C']);
    expect(res.body.waiting[0].position).toBe(1);
    expect(res.body.waiting[1].position).toBe(2);
  });

  test('excludes a served lot from now-serving/waiting, promoting the next one', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerA = await insertFarmerWithLand(pool, { farmerName: 'Farmer A' });
    const farmerB = await insertFarmerWithLand(pool, { farmerName: 'Farmer B' });
    const bookingA = await insertBooking(pool, { centreDayId, farmerId: farmerA, token: 'TOK-A', status: 'checked_in', checkedInAt: '2026-09-16T06:00:00Z' });
    await insertBooking(pool, { centreDayId, farmerId: farmerB, token: 'TOK-B', status: 'checked_in', checkedInAt: '2026-09-16T06:10:00Z' });

    const officer = centreOfficerAgent(app, centreId);
    const served = await officer.post(`/api/lots/${bookingA}/serve`).send();
    expect(served.status).toBe(200);

    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });
    expect(res.body.nowServing.token).toBe('TOK-B');
    expect(res.body.waiting).toEqual([]);
    expect(res.body.servedCount).toBe(1);
  });

  test('ETA is position times the centre\'s service-time EWMA, not a fixed average', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await pool.query('UPDATE centres SET service_time_ewma_minutes = 12 WHERE id = $1', [centreId]);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });

    for (let i = 0; i < 3; i++) {
      const farmerId = await insertFarmerWithLand(pool, { farmerName: `Farmer ${i}` });
      await insertBooking(pool, {
        centreDayId,
        farmerId,
        token: `TOK-${i}`,
        status: 'checked_in',
        checkedInAt: `2026-09-16T06:0${i}:00Z`,
      });
    }

    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });

    expect(res.body.averageWaitMinutes).toBe(12);
    expect(res.body.waiting[0].etaMinutes).toBe(12); // position 1 * 12
    expect(res.body.waiting[1].etaMinutes).toBe(24); // position 2 * 12
  });

  test('ETA is null, not a fabricated number, when the centre has no observed EWMA yet', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerA = await insertFarmerWithLand(pool, {});
    const farmerB = await insertFarmerWithLand(pool, {});
    await insertBooking(pool, { centreDayId, farmerId: farmerA, token: 'TOK-A', status: 'checked_in', checkedInAt: '2026-09-16T06:00:00Z' });
    await insertBooking(pool, { centreDayId, farmerId: farmerB, token: 'TOK-B', status: 'checked_in', checkedInAt: '2026-09-16T06:10:00Z' });

    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });

    expect(res.body.averageWaitMinutes).toBeNull();
    expect(res.body.waiting[0].etaMinutes).toBeNull();
  });

  test('includes the moisture limit, for the board', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await require('supertest')(app).get(`/api/centres/${centreId}/queue`).query({ date: DATE });
    expect(res.body.moistureLimitPct).toBe(17.0);
  });
});
