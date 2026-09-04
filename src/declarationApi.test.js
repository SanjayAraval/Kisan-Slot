'use strict';

const request = require('supertest');
const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const { insertCentre, insertDailyInputs, DAILY_INPUT_BASELINE } = require('./testUtils/fixtures');

const DATE = '2026-09-05';

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  return { pool, app };
}

function fullDeclarationBody(overrides = {}) {
  return {
    date: DATE,
    weighingMode: 'weighbridge',
    weighbridgeOperatingMinutes: 480,
    weighbridgeAvgCycleMinutes: 8,
    secondsPerBag: null,
    avgBagsPerLot: null,
    hamaliGangCount: 10,
    hamaliBagsPerGangPerDay: 600,
    bagsPerTruck: 100,
    gunnyBagsAvailable: 6000,
    truckEvacuationCapacity: 60,
    yardCapacityTonnes: 600,
    undispatchedTonnes: 0,
    avgTruckLoadTonnes: 10,
    moistureMeterCount: 5,
    moistureTestsPerMeterPerDay: 100,
    ...overrides,
  };
}

describe('GET /api/centres', () => {
  test('lists centres', async () => {
    const { app, pool } = setup();
    await insertCentre(pool, { name: 'Medak APMC Mandi', code: 'MDK-01' });

    const res = await request(app).get('/api/centres');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].code).toBe('MDK-01');
  });
});

describe('GET /api/centres/:id/declaration', () => {
  test('404s when nothing is declared for that date', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await request(app).get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(res.status).toBe(404);
  });

  test('returns the current declared inputs', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE, overrides: { gunnyBagsAvailable: 4321 } });

    const res = await request(app).get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(res.status).toBe(200);
    expect(res.body.inputs.gunnyBagsAvailable).toBe(4321);
    expect(res.body.inputs.hamaliGangCount).toBe(DAILY_INPUT_BASELINE.hamaliGangCount);
  });

  test('400s without a date', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await request(app).get(`/api/centres/${centreId}/declaration`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/centres/:id/declaration', () => {
  test('creates a first declaration and returns the recomputed capacity', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await request(app)
      .post(`/api/centres/${centreId}/declaration`)
      .send(fullDeclarationBody({ truckEvacuationCapacity: 20 })); // -> binds truckEvacuation

    expect(res.status).toBe(200);
    expect(res.body.totalCapacity).toBe(20);
    expect(res.body.bindingConstraint).toBe('truckEvacuation');
    expect(res.body.bookableCapacity).toBe(20 - Math.ceil(20 * 0.2));
    expect(res.body.recommendedAction).toMatch(/truck/i);
    expect(res.body.constraints.truckEvacuation).toBe(20);

    // Round-trips through a subsequent GET.
    const getRes = await request(app).get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(getRes.status).toBe(200);
    expect(getRes.body.inputs.truckEvacuationCapacity).toBe(20);

    const centreDay = await pool.query('SELECT bookable_capacity, binding_constraint FROM centre_day WHERE centre_id = $1', [
      centreId,
    ]);
    expect(centreDay.rows[0].binding_constraint).toBe('truckEvacuation');
  });

  test('a second declaration for the same date corrects the first (upsert, not a new row)', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);

    await request(app).post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ gunnyBagsAvailable: 1000 }));
    const second = await request(app)
      .post(`/api/centres/${centreId}/declaration`)
      .send(fullDeclarationBody({ gunnyBagsAvailable: 6000, truckEvacuationCapacity: 15 }));

    expect(second.status).toBe(200);
    expect(second.body.bindingConstraint).toBe('truckEvacuation');

    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM centre_daily_inputs WHERE centre_id = $1', [centreId]);
    expect(rows.rows[0].n).toBe(1); // corrected in place, not appended

    const centreDayRows = await pool.query('SELECT COUNT(*)::int AS n FROM centre_day WHERE centre_id = $1', [centreId]);
    expect(centreDayRows.rows[0].n).toBe(1);
  });

  test('rejects an incomplete declaration with 400', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await request(app)
      .post(`/api/centres/${centreId}/declaration`)
      .send({ date: DATE, weighingMode: 'weighbridge' });

    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('platform mode requires secondsPerBag/avgBagsPerLot instead of a cycle time', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await request(app)
      .post(`/api/centres/${centreId}/declaration`)
      .send(fullDeclarationBody({ weighingMode: 'platform', weighbridgeAvgCycleMinutes: null }));

    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/secondsPerBag/);
  });

  test('404s for an unknown centre', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/centres/00000000-0000-0000-0000-000000000000/declaration')
      .send(fullDeclarationBody());
    expect(res.status).toBe(404);
  });
});
