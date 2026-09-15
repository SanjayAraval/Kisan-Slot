'use strict';

const request = require('supertest');
const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const { insertCentre, insertDailyInputs, insertFarmerWithLand, DAILY_INPUT_BASELINE } = require('./testUtils/fixtures');
const { districtOfficerAgent, centreOfficerAgent, farmerAgent } = require('./testUtils/authTestHelpers');

const DATE = '2026-09-05';

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  // District officer for 'Medak' -- matches insertCentre's default
  // district, so this one identity is authorized for every centre these
  // tests create without needing to know its id up front.
  const agent = districtOfficerAgent(app);
  return { pool, app, agent };
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
    const { app, agent, pool } = setup();
    await insertCentre(pool, { name: 'Medak APMC Mandi', code: 'MDK-01' });

    const res = await agent.get('/api/centres');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].code).toBe('MDK-01');
  });

  test('includes a transliterated name per centre so non-English readers can identify it', async () => {
    const { app, agent, pool } = setup();
    await insertCentre(pool, {
      name: 'Medak APMC Mandi',
      nameHi: 'मेडक एपीएमसी मंडी',
      nameTe: 'మెదక్ ఏపీఎంసీ మండి',
      code: 'MDK-01',
    });

    const res = await agent.get('/api/centres');
    expect(res.status).toBe(200);
    expect(res.body[0].nameHi).toBe('मेडक एपीएमसी मंडी');
    expect(res.body[0].nameTe).toBe('మెదక్ ఏపీఎంసీ మండి');
  });

  test('omits `remaining` when no date query param is given', async () => {
    const { app, agent, pool } = setup();
    await insertCentre(pool, { code: 'MDK-01' });

    const res = await agent.get('/api/centres');
    expect(res.status).toBe(200);
    expect(res.body[0].remaining).toBeUndefined();
  });

  test('with a date, annotates each centre with remaining bookable slots for that date', async () => {
    const { app, agent, pool } = setup();
    const declaredCentreId = await insertCentre(pool, { code: 'MDK-01' });
    const undeclaredCentreId = await insertCentre(pool, { code: 'MDK-02' });
    const officer = centreOfficerAgent(app, declaredCentreId);
    await officer.post(`/api/centres/${declaredCentreId}/declaration`).send(fullDeclarationBody());

    const res = await agent.get('/api/centres').query({ date: DATE });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((c) => [c.id, c.remaining]));
    expect(byId[declaredCentreId]).toBeGreaterThan(0);
    // No declaration on file at all -- treated as zero remaining, not
    // omitted or null, so the farmer screen can filter on a plain number.
    expect(byId[undeclaredCentreId]).toBe(0);
  });

  test('400s on a malformed date query param', async () => {
    const { app, agent, pool } = setup();
    await insertCentre(pool);

    const res = await agent.get('/api/centres').query({ date: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/centres/:id/declaration', () => {
  test('404s when nothing is declared for that date', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);

    const res = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(res.status).toBe(404);
  });

  test('returns the current declared inputs', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE, overrides: { gunnyBagsAvailable: 4321 } });

    const res = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(res.status).toBe(200);
    expect(res.body.inputs.gunnyBagsAvailable).toBe(4321);
    expect(res.body.inputs.hamaliGangCount).toBe(DAILY_INPUT_BASELINE.hamaliGangCount);
    expect(res.body.inputs.updatedAt).toBeTruthy();
  });

  test('400s without a date', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const res = await agent.get(`/api/centres/${centreId}/declaration`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/centres/:id/declaration', () => {
  test('creates a first declaration and returns the recomputed capacity', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const officer = centreOfficerAgent(app, centreId);

    const res = await officer
      .post(`/api/centres/${centreId}/declaration`)
      .send(fullDeclarationBody({ truckEvacuationCapacity: 20 })); // -> binds truckEvacuation

    expect(res.status).toBe(200);
    expect(res.body.totalCapacity).toBe(20);
    expect(res.body.bindingConstraint).toBe('truckEvacuation');
    expect(res.body.bookableCapacity).toBe(20 - Math.ceil(20 * 0.2));
    expect(res.body.recommendedAction).toMatch(/truck/i);
    expect(res.body.constraints.truckEvacuation).toBe(20);

    // Round-trips through a subsequent GET.
    const getRes = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(getRes.status).toBe(200);
    expect(getRes.body.inputs.truckEvacuationCapacity).toBe(20);

    const centreDay = await pool.query('SELECT bookable_capacity, binding_constraint FROM centre_day WHERE centre_id = $1', [
      centreId,
    ]);
    expect(centreDay.rows[0].binding_constraint).toBe('truckEvacuation');
  });

  test('a second declaration for the same date corrects the first (upsert, not a new row)', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const officer = centreOfficerAgent(app, centreId);

    await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ gunnyBagsAvailable: 1000 }));
    const second = await officer
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
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const officer = centreOfficerAgent(app, centreId);

    const res = await officer
      .post(`/api/centres/${centreId}/declaration`)
      .send({ date: DATE, weighingMode: 'weighbridge' });

    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('platform mode requires secondsPerBag/avgBagsPerLot instead of a cycle time', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);
    const officer = centreOfficerAgent(app, centreId);

    const res = await officer
      .post(`/api/centres/${centreId}/declaration`)
      .send(fullDeclarationBody({ weighingMode: 'platform', weighbridgeAvgCycleMinutes: null }));

    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/secondsPerBag/);
  });

  test('reports every tied constraint, not just the first, when several bind at once', async () => {
    const { app, agent, pool } = setup();
    const centreId = await insertCentre(pool);

    // weighbridge=60, hamali=60, gunny=60, truckEvacuation=60, yardSpace=60,
    // moistureTesting=500 -- five-way tie at 60.
    const officer = centreOfficerAgent(app, centreId);
    const res = await officer
      .post(`/api/centres/${centreId}/declaration`)
      .send(fullDeclarationBody());

    expect(res.status).toBe(200);
    expect(res.body.totalCapacity).toBe(60);
    expect(res.body.bindingConstraint).toBe('weighbridge');
    expect(res.body.bindingConstraints).toEqual([
      'weighbridge', 'hamali', 'gunny', 'truckEvacuation', 'yardSpace',
    ]);
  });

  test('a district officer may view a declaration but not submit one -- only that centre\'s own officer can', async () => {
    const { app, agent, pool } = setup(); // agent: district officer for 'Medak'
    const centreId = await insertCentre(pool); // district 'Medak' by default
    const otherCentreId = await insertCentre(pool, { code: 'MDK-02' });
    const officer = centreOfficerAgent(app, centreId);
    const otherOfficer = centreOfficerAgent(app, otherCentreId);

    const districtSubmit = await agent.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody());
    expect(districtSubmit.status).toBe(403);

    const wrongCentreSubmit = await otherOfficer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody());
    expect(wrongCentreSubmit.status).toBe(403);

    const ownSubmit = await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody());
    expect(ownSubmit.status).toBe(200);

    // District officer retains read access for oversight.
    const districtRead = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(districtRead.status).toBe(200);
  });

  test('404s for an unknown centre', async () => {
    const { app } = setup();
    const unknownCentreId = '00000000-0000-0000-0000-000000000000';
    const officer = centreOfficerAgent(app, unknownCentreId);
    const res = await officer
      .post(`/api/centres/${unknownCentreId}/declaration`)
      .send(fullDeclarationBody());
    expect(res.status).toBe(404);
  });

  describe('stale resubmit protection (release-bags vs. an outdated declaration form)', () => {
    test('after bags are released from the dashboard, the declaration screen shows the updated capacity', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);
      await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ gunnyBagsAvailable: 6000 }));

      const release = await agent
        .post(`/api/dashboard/centres/${centreId}/release-bags`)
        .send({ date: DATE, additionalBags: 500 });
      expect(release.status).toBe(200);
      expect(release.body.gunnyBagsAvailable).toBe(6500);

      const declaration = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
      expect(declaration.status).toBe(200);
      expect(declaration.body.inputs.gunnyBagsAvailable).toBe(6500);

      const centreDay = await pool.query('SELECT bags_capacity FROM centre_day WHERE centre_id = $1', [centreId]);
      expect(Number(centreDay.rows[0].bags_capacity)).toBeGreaterThan(0);
    });

    test('resubmitting a form loaded before a release-bags change is rejected as stale, not silently applied', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);
      await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ gunnyBagsAvailable: 6000 }));

      // The officer loads the form -- captures the version at this point.
      const loaded = await officer.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
      const staleVersion = loaded.body.inputs.updatedAt;

      // Meanwhile, bags are released from the dashboard.
      await agent.post(`/api/dashboard/centres/${centreId}/release-bags`).send({ date: DATE, additionalBags: 500 });

      // The officer's browser still has the old form open and submits it.
      const resubmit = await officer
        .post(`/api/centres/${centreId}/declaration`)
        .send(fullDeclarationBody({ gunnyBagsAvailable: 6000, expectedUpdatedAt: staleVersion }));

      expect(resubmit.status).toBe(409);
      expect(resubmit.body.status).toBe('CONFLICT');
      expect(resubmit.body.message).toMatch(/changed by someone else/i);

      // The dashboard's release is NOT undone.
      const after = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
      expect(after.body.inputs.gunnyBagsAvailable).toBe(6500);
    });

    test('resubmitting with the current version succeeds normally', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);
      await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ gunnyBagsAvailable: 6000 }));

      const loaded = await officer.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
      const currentVersion = loaded.body.inputs.updatedAt;

      const resubmit = await officer
        .post(`/api/centres/${centreId}/declaration`)
        .send(fullDeclarationBody({ gunnyBagsAvailable: 7000, expectedUpdatedAt: currentVersion }));

      expect(resubmit.status).toBe(200);
      const after = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
      expect(after.body.inputs.gunnyBagsAvailable).toBe(7000);
    });

    test('a first-ever declaration for a centre/date is unaffected by expectedUpdatedAt', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);

      const res = await officer
        .post(`/api/centres/${centreId}/declaration`)
        .send(fullDeclarationBody({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }));

      expect(res.status).toBe(200);
    });
  });

  describe('bags, gangs and trucks must be positive integers within plausible bounds', () => {
    test('rejects zero for gunny bags, hamali gangs and truck evacuation', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);

      const bags = await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ gunnyBagsAvailable: 0 }));
      expect(bags.status).toBe(400);
      expect(bags.body.errors.join(' ')).toMatch(/gunnyBagsAvailable/);

      const gangs = await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ hamaliGangCount: 0 }));
      expect(gangs.status).toBe(400);
      expect(gangs.body.errors.join(' ')).toMatch(/hamaliGangCount/);

      const trucks = await officer.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody({ truckEvacuationCapacity: 0 }));
      expect(trucks.status).toBe(400);
      expect(trucks.body.errors.join(' ')).toMatch(/truckEvacuationCapacity/);
    });

    test('rejects negative values', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);

      const res = await officer
        .post(`/api/centres/${centreId}/declaration`)
        .send(fullDeclarationBody({ hamaliGangCount: -3 }));
      expect(res.status).toBe(400);
    });

    test('rejects fractional values', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);

      const res = await officer
        .post(`/api/centres/${centreId}/declaration`)
        .send(fullDeclarationBody({ gunnyBagsAvailable: 100.5 }));
      expect(res.status).toBe(400);
      expect(res.body.errors.join(' ')).toMatch(/gunnyBagsAvailable/);
    });

    test('rejects values above the plausible ceiling', async () => {
      const { app, agent, pool } = setup();
      const centreId = await insertCentre(pool);
      const officer = centreOfficerAgent(app, centreId);

      const res = await officer
        .post(`/api/centres/${centreId}/declaration`)
        .send(fullDeclarationBody({ truckEvacuationCapacity: 5000 }));
      expect(res.status).toBe(400);
      expect(res.body.errors.join(' ')).toMatch(/truckEvacuationCapacity/);
    });
  });
});

// The declaration link is hidden from a farmer's UI, but the server is
// the actual authority -- confirms it refuses a farmer regardless of
// what any client sends.
describe('a farmer session cannot reach centre-officer-only declaration routes', () => {
  test('GET /api/centres/:id/declaration is refused', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const agent = farmerAgent(app, farmerId);

    const res = await agent.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(res.status).toBe(403);
  });

  test('POST /api/centres/:id/declaration is refused', async () => {
    const pool = createTestPool();
    const app = createApp(pool);
    const centreId = await insertCentre(pool);
    const farmerId = await insertFarmerWithLand(pool, {});
    const agent = farmerAgent(app, farmerId);

    const res = await agent.post(`/api/centres/${centreId}/declaration`).send(fullDeclarationBody());
    expect(res.status).toBe(403);
  });
});
