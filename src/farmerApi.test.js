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
const { todayInIST } = require('./todayInIST');

const DATE = '2026-09-04';
const TOKEN = 'FARMER-TEST-001';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
    const centreId = await insertCentre(pool, { code: 'MDK-TEST-01', nameHi: 'मेडक टेस्ट केंद्र', nameTe: 'మెదక్ టెస్ట్ కేంద్రం' });
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
    expect(res.body).toHaveLength(1);
    const [entry] = res.body;
    expect(entry.booking.token).toBe(TOKEN);
    expect(entry.booking.centreCode).toBe('MDK-TEST-01');
    expect(entry.booking.centreNameHi).toBe('मेडक टेस्ट केंद्र');
    expect(entry.booking.centreNameTe).toBe('మెదక్ టెస్ట్ కేంద్రం');
    expect(entry.stages.map((s) => s.done)).toEqual([false, false, false, false, false, false]);
    expect(entry.moisture).toBeNull();
    expect(entry.weighment).toBeNull();
    expect(entry.isToday).toBe(DATE === todayInIST());
  });

  test('after the full lot workflow: stages, moisture, and weighment reflect real timestamps, then the lot moves to the J-Form step once billed', async () => {
    const { app, agent, pool } = setup();
    const { farmerId, bookingId } = await setupBookedLot(pool);

    await agent.post(`/api/lots/${bookingId}/checkin`).send({ token: TOKEN });
    await agent
      .post(`/api/lots/${bookingId}/quality`)
      .send({ meterId: 'MTR-07', calibrationDate: '2026-08-01', samples: [16.5, 16.8, 16.7] });
    await agent.post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 });

    const res = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const byKey = Object.fromEntries(res.body[0].stages.map((s) => [s.key, s]));
    expect(byKey.gate_entry.done).toBe(true);
    expect(byKey.moisture_test.done).toBe(true);
    expect(byKey.weighment.done).toBe(true);
    expect(byKey.acknowledgement.done).toBe(true); // set by the same weighment call
    expect(byKey.bill_raised.done).toBe(false); // no J-Form yet
    expect(byKey.payment.done).toBe(false); // never tracked

    expect(res.body[0].moisture.meterId).toBe('MTR-07');
    expect(res.body[0].moisture.meanMoisture).toBeCloseTo(16.7, 1);
    expect(res.body[0].moisture.verdict).toBe('accept');
    expect(res.body[0].moisture.limitPct).toBe(17.0);
    expect(res.body[0].weighment.netKg).toBe(4000);

    const jform = await agent.post(`/api/lots/${bookingId}/jform`).send({ mspRate: 2183 });
    expect(jform.status).toBe(201);

    // Once billed, the lot is done -- it drops off the STATUS screen (see
    // GET /api/farmers/:id/jform below for where it goes instead).
    const res2 = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(res2.status).toBe(404);
  });

  test('multiple upcoming bookings on different dates all show, ordered by date, with today flagged', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool, { code: 'MDK-TEST-02' });
    const today = todayInIST();
    const laterDate = addDays(today, 6);
    await insertDailyInputs(pool, { centreId, serviceDate: today });
    await insertDailyInputs(pool, { centreId, serviceDate: laterDate });
    const todayCentreDayId = await insertCentreDay(pool, { centreId, serviceDate: today, bagsCapacity: 4800, bagsBooked: 100 });
    const laterCentreDayId = await insertCentreDay(pool, { centreId, serviceDate: laterDate, bagsCapacity: 4800, bagsBooked: 100 });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    // Inserted out of date order to prove the response sorts, not just echoes insert order.
    await insertBooking(pool, { centreDayId: laterCentreDayId, farmerId, token: 'TOKEN-LATER', status: 'booked' });
    await insertBooking(pool, { centreDayId: todayCentreDayId, farmerId, token: 'TOKEN-TODAY', status: 'booked' });

    const res = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.booking.token)).toEqual(['TOKEN-TODAY', 'TOKEN-LATER']);
    expect(res.body.map((e) => e.isToday)).toEqual([true, false]);
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
    expect(res.body).toHaveLength(1);
    const [jForm] = res.body;
    expect(jForm.quintalsProcured).toBe(40);
    expect(jForm.mspRate).toBe(2183);
    expect(jForm.grossAmount).toBe(40 * 2183);
    expect(jForm.deductions).toEqual([
      { type: 'moisture_cut', amount: 50, description: null },
      { type: 'transport', amount: 20, description: null },
    ]);
    expect(jForm.totalDeductions).toBe(70);
    expect(jForm.netPayable).toBe(40 * 2183 - 70);
    expect(jForm.effectiveRatePerQuintal).toBe(round(jForm.netPayable / 40));

    // Billed, so it no longer shows as an upcoming booking.
    const status = await agent.get(`/api/farmers/${farmerId}/status`);
    expect(status.status).toBe(404);
  });

  test('multiple completed lots all show, newest bill first', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool, { code: 'MDK-TEST-03' });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 20 });

    async function completeLot(serviceDate, token, mspRate) {
      await insertDailyInputs(pool, { centreId, serviceDate });
      const centreDayId = await insertCentreDay(pool, { centreId, serviceDate, bagsCapacity: 4800, bagsBooked: 100 });
      const bookingId = await insertBooking(pool, {
        centreDayId,
        farmerId,
        token,
        declaredQuantityQuintals: 40,
        bagsReserved: 100,
        status: 'booked',
      });
      await agent.post(`/api/lots/${bookingId}/checkin`).send({ token });
      await agent
        .post(`/api/lots/${bookingId}/quality`)
        .send({ meterId: 'MTR-01', calibrationDate: '2026-08-01', samples: [16.0, 16.0, 16.0] });
      await agent.post(`/api/lots/${bookingId}/weigh`).send({ grossKg: 4200, tareKg: 200 });
      const res = await agent.post(`/api/lots/${bookingId}/jform`).send({ mspRate });
      expect(res.status).toBe(201);
      return bookingId;
    }

    await completeLot(DATE, 'TOKEN-LOT-1', 2183);
    await completeLot(addDays(DATE, 1), 'TOKEN-LOT-2', 2200);

    const res = await agent.get(`/api/farmers/${farmerId}/jform`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Newest bill issued first -- the second lot was billed after the first.
    expect(res.body.map((j) => j.token)).toEqual(['TOKEN-LOT-2', 'TOKEN-LOT-1']);
    expect(res.body.map((j) => j.mspRate)).toEqual([2200, 2183]);
  });
});
