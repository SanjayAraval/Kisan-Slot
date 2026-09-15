'use strict';

const request = require('supertest');
const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertDailyInputs,
  insertCentreDay,
  insertFarmer,
  insertFarmerWithLand,
  insertLandRecord,
  insertBooking,
} = require('./testUtils/fixtures');
const { districtOfficerAgent } = require('./testUtils/authTestHelpers');

const DATE = '2026-09-04';
const TOKEN = 'FARMER-TEST-001';

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  // District officer: unrestricted read access to any farmer (oversight),
  // matching the fixtures' default district ('Medak').
  const agent = districtOfficerAgent(app);
  return { pool, app, agent };
}

describe('GET /api/farmers', () => {
  test('lists farmers by name', async () => {
    const { app, agent, pool } = setup();
    await insertFarmer(pool, { farmerName: 'Zzyx Reddy' });
    await insertFarmer(pool, { farmerName: 'Aarav Rao' });

    const res = await agent.get('/api/farmers');
    expect(res.status).toBe(200);
    expect(res.body.map((f) => f.name)).toEqual(['Aarav Rao', 'Zzyx Reddy']);
  });
});

describe('GET /api/farmers/:id', () => {
  test('404s for an unknown farmer', async () => {
    const { app, agent } = setup();
    const res = await agent.get('/api/farmers/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('a matched, non-tenant farmer: full detail, no review flag', async () => {
    const { app, agent, pool } = setup();
    const landRecordId = await insertLandRecord(pool, { extentAcres: 5, village: 'Kondapur' }); // land estimate 120q, cap 156q
    const farmerId = await insertFarmer(pool, {
      landRecordId,
      farmerName: 'Ravi Kumar',
      isTenant: false,
    });
    await pool.query('UPDATE farmers SET bank_account_number = $1 WHERE id = $2', ['123456789012', farmerId]);

    const res = await agent.get(`/api/farmers/${farmerId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Ravi Kumar');
    expect(res.body.village).toBe('Kondapur');
    expect(res.body.hasLandRecord).toBe(true);
    expect(res.body.needsOfficerReview).toBe(false);
    expect(res.body.landEstimateQuintals).toBe(120);
    expect(res.body.permittedQuantityQuintals).toBe(156);
    expect(res.body.bankAccountLast4).toBe('9012');
  });

  test('a farmer with no land record needs officer review', async () => {
    const { app, agent, pool } = setup();
    const farmerId = await insertFarmer(pool, { landRecordId: null });

    const res = await agent.get(`/api/farmers/${farmerId}`);
    expect(res.status).toBe(200);
    expect(res.body.hasLandRecord).toBe(false);
    expect(res.body.needsOfficerReview).toBe(true);
    expect(res.body.extentAcres).toBeNull();
    expect(res.body.permittedQuantityQuintals).toBeNull();
  });

  test('a tenant farmer needs officer review even though a land record exists', async () => {
    const { app, agent, pool } = setup();
    const landRecordId = await insertLandRecord(pool, { extentAcres: 3 });
    const farmerId = await insertFarmer(pool, { landRecordId, isTenant: true });

    const res = await agent.get(`/api/farmers/${farmerId}`);
    expect(res.status).toBe(200);
    expect(res.body.hasLandRecord).toBe(true);
    expect(res.body.isTenant).toBe(true);
    expect(res.body.needsOfficerReview).toBe(true);
  });
});

describe('GET /api/farmers/:id/status', () => {
  async function setupBookedLot(pool) {
    const centreId = await insertCentre(pool, { code: 'MDK-TEST-01' });
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE, bagsCapacity: 4800, bagsBooked: 100 });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });
    const bookingId = await insertBooking(pool, {
      centreDayId,
      farmerId,
      token: TOKEN,
      declaredQuantityQuintals: 40,
      bagsReserved: 100,
      status: 'booked',
    });
    return { farmerId, bookingId };
  }

  test('404s when the farmer has no bookings on file', async () => {
    const { app, agent, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, {});

    const res = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(res.status).toBe(404);
  });

  test('a freshly booked lot: only the booking itself, every stage pending', async () => {
    const { app, agent, pool } = setup();
    const { farmerId } = await setupBookedLot(pool);

    const res = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.booking.token).toBe(TOKEN);
    expect(res.body.booking.centreCode).toBe('MDK-TEST-01');
    expect(res.body.stages.map((s) => s.done)).toEqual([false, false, false, false, false, false]);
    expect(res.body.moisture).toBeNull();
    expect(res.body.weighment).toBeNull();
  });

  test('after the full lot workflow: stages, moisture, and weighment reflect real timestamps', async () => {
    const { app, agent, pool } = setup();
    const { farmerId, bookingId } = await setupBookedLot(pool);

    await agent.post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    await agent
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-07', calibrationDate: '2026-08-01', samples: [16.5, 16.8, 16.7] });
    await agent.post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 });

    const res = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(res.status).toBe(200);

    const byKey = Object.fromEntries(res.body.stages.map((s) => [s.key, s]));
    expect(byKey.gate_entry.done).toBe(true);
    expect(byKey.moisture_test.done).toBe(true);
    expect(byKey.weighment.done).toBe(true);
    expect(byKey.acknowledgement.done).toBe(true); // set by the same weighment call
    expect(byKey.bill_raised.done).toBe(false); // no J-Form yet
    expect(byKey.payment.done).toBe(false); // never tracked

    expect(res.body.moisture.meterId).toBe('MTR-07');
    expect(res.body.moisture.meanMoisture).toBeCloseTo(16.7, 1);
    expect(res.body.moisture.verdict).toBe('accept');
    expect(res.body.moisture.limitPct).toBe(17.0);
    expect(res.body.weighment.netKg).toBe(4000);

    const jform = await agent.post(`/api/lots/${bookingId}/jform`).send({ mspRate: 2183 });
    expect(jform.status).toBe(201);

    const res2 = await agent.get(`/api/farmers/${farmerId}/status`);
    const byKey2 = Object.fromEntries(res2.body.stages.map((s) => [s.key, s]));
    expect(byKey2.bill_raised.done).toBe(true);
  });
});

describe('GET /api/farmers/:id/jform', () => {
  test('404s when no J-Form has been issued yet', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    await insertBooking(pool, { centreDayId, farmerId, token: TOKEN });

    const res = await agent.get(`/api/farmers/${farmerId}/jform`);
    expect(res.status).toBe(404);
  });

  test('itemises deductions and derives net payable and effective rate', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE, bagsCapacity: 4800, bagsBooked: 100 });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });
    const bookingId = await insertBooking(pool, {
      centreDayId,
      farmerId,
      token: TOKEN,
      declaredQuantityQuintals: 40,
      bagsReserved: 100,
      status: 'booked',
    });

    await agent.post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    await agent
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [16.0, 16.0, 16.0] });
    await agent.post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 }); // netKg 4000 -> 40q
    await agent
      .post(`/api/lots/${bookingId}/jform`)
      .send({
        mspRate: 2183,
        deductions: [
          { type: 'moisture_cut', amount: 50 },
          { type: 'transport', amount: 20 },
        ],
      });

    const res = await agent.get(`/api/farmers/${farmerId}/jform`);
    expect(res.status).toBe(200);
    expect(res.body.quintalsProcured).toBe(40);
    expect(res.body.mspRate).toBe(2183);
    expect(res.body.grossAmount).toBe(40 * 2183);
    expect(res.body.deductions).toEqual([
      { type: 'moisture_cut', amount: 50, description: null },
      { type: 'transport', amount: 20, description: null },
    ]);
    expect(res.body.totalDeductions).toBe(70);
    expect(res.body.netPayable).toBe(40 * 2183 - 70);
    expect(res.body.effectiveRatePerQuintal).toBe(round(res.body.netPayable / 40));
  });
});
