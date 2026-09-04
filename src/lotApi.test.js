'use strict';

const request = require('supertest');
const { createApp } = require('./app');
const { runNightlyReallocation } = require('./reallocationJob');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertDailyInputs,
  insertCentreDay,
  insertFarmerWithLand,
  insertBooking,
} = require('./testUtils/fixtures');

const TODAY = '2026-09-04';
const TOKEN = 'TESTTOKEN-001';

async function setupBookedLot(pool, overrides = {}) {
  const centreId = await insertCentre(pool, { code: 'MDK-TEST-01' });
  await insertDailyInputs(pool, { centreId, serviceDate: TODAY, overrides: overrides.dailyInputs });
  const centreDayId = await insertCentreDay(pool, {
    centreId,
    serviceDate: TODAY,
    bagsCapacity: 4800,
    bagsBooked: 100,
  });
  const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 }); // land estimate 120q, cap 156q
  const bookingId = await insertBooking(pool, {
    centreDayId,
    farmerId,
    token: TOKEN,
    declaredQuantityQuintals: 40,
    bagsReserved: 100,
    status: 'booked',
  });
  return { centreId, bookingId };
}

describe('lot workflow', () => {
  test('full happy path: checkin -> quality (accept) -> weigh -> J-Form -> dispatch, feeding the EWMA', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const { centreId, bookingId } = await setupBookedLot(pool);

    const checkin = await request(app).post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    expect(checkin.status).toBe(200);
    expect(checkin.body.checkedInAt).toBeDefined();

    const quality = await request(app)
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [16.5, 16.8, 16.7] });
    expect(quality.status).toBe(201);
    expect(quality.body.mean).toBeCloseTo(16.7, 1);
    expect(quality.body.verdict).toBe('accept');

    const weigh = await request(app)
      .post(`/api/lots/${bookingId}/weigh`)
      .send({ grossKg: 4200, tareKg: 200 });
    expect(weigh.status).toBe(201);
    expect(weigh.body.mode).toBe('weighbridge');
    expect(weigh.body.netKg).toBe(4000);
    expect(weigh.body.bagsUsed).toBe(100); // 4000 / 40
    expect(weigh.body.completedAt).toBeDefined();

    const jform = await request(app)
      .post(`/api/lots/${bookingId}/jform`)
      .send({
        mspRate: 2183,
        deductions: [
          { type: 'moisture_cut', amount: 50 },
          { type: 'transport', amount: 20 },
        ],
      });
    expect(jform.status).toBe(201);
    expect(jform.body.quintalsProcured).toBe(40); // 4000kg / 100
    expect(jform.body.grossAmount).toBe(40 * 2183);
    expect(jform.body.totalDeductions).toBe(70);
    expect(jform.body.netPayable).toBe(40 * 2183 - 70);
    expect(jform.body.supersedesJFormId).toBeNull();

    const dispatch = await request(app)
      .post(`/api/lots/${bookingId}/dispatch`)
      .send({ vehicleNumber: 'TS01AB1234' });
    expect(dispatch.status).toBe(201);
    expect(dispatch.body.vehicleNumber).toBe('TS01AB1234');

    // Service time is derived from automatic timestamps, not entered.
    const bookingRow = await pool.query(
      'SELECT status, checked_in_at, completed_at FROM bookings WHERE id = $1',
      [bookingId]
    );
    expect(bookingRow.rows[0].status).toBe('completed');
    expect(bookingRow.rows[0].checked_in_at).not.toBeNull();
    expect(bookingRow.rows[0].completed_at).not.toBeNull();
    expect(new Date(bookingRow.rows[0].completed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(bookingRow.rows[0].checked_in_at).getTime()
    );

    // Bags used were deducted from actual centre stock (distinct from the
    // booking-time reservation estimate).
    const dailyInputRow = await pool.query(
      'SELECT gunny_bags_available FROM centre_daily_inputs WHERE centre_id = $1 AND service_date = $2',
      [centreId, TODAY]
    );
    expect(Number(dailyInputRow.rows[0].gunny_bags_available)).toBe(6000 - 100);

    // That derived service time actually reaches the nightly EWMA.
    const plan = await runNightlyReallocation(pool, { today: TODAY });
    expect(plan.ewmaUpdates).toHaveLength(1);
    expect(plan.ewmaUpdates[0].centreId).toBe(centreId);
    const centreRow = await pool.query('SELECT service_time_ewma_minutes FROM centres WHERE id = $1', [centreId]);
    expect(Number(centreRow.rows[0].service_time_ewma_minutes)).toBeGreaterThanOrEqual(0);
  });

  test('a moisture rejection at 19.4% stops the lot before weighing', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const { bookingId } = await setupBookedLot(pool);

    await request(app).post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });

    const quality = await request(app)
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [19.3, 19.4, 19.5] });

    expect(quality.status).toBe(201);
    expect(quality.body.mean).toBe(19.4);
    expect(quality.body.verdict).toBe('reject');

    const bookingRow = await pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(bookingRow.rows[0].status).toBe('rejected');

    const weigh = await request(app).post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 });
    expect(weigh.status).toBe(409);
    expect(weigh.body.status).toBe('CONFLICT');
  });

  test('a cut verdict (between 17.0% and 19.0%) still allows weighing to proceed', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const { bookingId } = await setupBookedLot(pool);

    await request(app).post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    const quality = await request(app)
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [18.0, 18.2, 18.1] });
    expect(quality.body.verdict).toBe('cut');

    const weigh = await request(app).post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 });
    expect(weigh.status).toBe(201);
  });

  test('checkin rejects a mismatched token without changing booking state', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const { bookingId } = await setupBookedLot(pool);

    const res = await request(app).post(`/api/lots/${bookingId}/checkin`).send({ token: 'WRONG-TOKEN' });
    expect(res.status).toBe(400);

    const bookingRow = await pool.query('SELECT status, checked_in_at FROM bookings WHERE id = $1', [bookingId]);
    expect(bookingRow.rows[0].status).toBe('booked');
    expect(bookingRow.rows[0].checked_in_at).toBeNull();
  });

  test('a J-Form correction supersedes the prior one and links a revision, never updating it', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const { bookingId } = await setupBookedLot(pool);

    await request(app).post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    await request(app)
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [16.0, 16.0, 16.0] });
    await request(app).post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 });

    const first = await request(app).post(`/api/lots/${bookingId}/jform`).send({ mspRate: 2183 });
    expect(first.status).toBe(201);
    expect(first.body.supersedesJFormId).toBeNull();

    const second = await request(app)
      .post(`/api/lots/${bookingId}/jform`)
      .send({ mspRate: 2200, deductions: [{ type: 'correction', amount: 10 }] });
    expect(second.status).toBe(201);
    expect(second.body.supersedesJFormId).toBe(first.body.jFormId);
    expect(second.body.jFormId).not.toBe(first.body.jFormId);

    const rows = await pool.query('SELECT id, status, supersedes_j_form_id FROM j_forms WHERE booking_id = $1 ORDER BY issued_at', [
      bookingId,
    ]);
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0].status).toBe('superseded');
    expect(rows.rows[1].status).toBe('active');
    expect(rows.rows[1].supersedes_j_form_id).toBe(rows.rows[0].id);
  });

  test('platform mode weighing sums per-bag entries instead of gross/tare', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const { bookingId } = await setupBookedLot(pool, {
      dailyInputs: { weighingMode: 'platform', secondsPerBag: 5, avgBagsPerLot: 20, weighbridgeAvgCycleMinutes: null },
    });

    await request(app).post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    await request(app)
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [16.0, 16.0, 16.0] });

    const bagEntries = Array.from({ length: 10 }, () => ({ weightKg: 40 }));
    const weigh = await request(app).post(`/api/lots/${bookingId}/weigh`).send({ bagEntries });

    expect(weigh.status).toBe(201);
    expect(weigh.body.mode).toBe('platform');
    expect(weigh.body.netKg).toBe(400);
    expect(weigh.body.bagsUsed).toBe(10);
  });
});
