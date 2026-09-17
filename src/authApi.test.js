'use strict';

const request = require('supertest');
const cookiejar = require('cookiejar');
const { createApp } = require('./app');
const { signToken, COOKIE_NAME } = require('./authService');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertDailyInputs,
  insertCentreDay,
  insertFarmer,
  insertFarmerWithLand,
  insertLandRecord,
  insertBooking,
  insertEmployee,
} = require('./testUtils/fixtures');
const { farmerAgent, districtOfficerAgent, centreOfficerAgent, operatorAgent } = require('./testUtils/authTestHelpers');

const DATE = '2026-09-05';

function setup() {
  const pool = createTestPool();
  const app = createApp(pool);
  return { pool, app };
}

async function fullyProcessedBooking(pool, { farmerId, centreId }) {
  await insertDailyInputs(pool, { centreId, serviceDate: DATE });
  const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE, bagsCapacity: 4800, bagsBooked: 100 });
  const bookingId = await insertBooking(pool, { centreDayId, farmerId, declaredQuantityQuintals: 40, bagsReserved: 100 });
  return bookingId;
}

describe('POST /api/auth/request-otp + verify-otp (farmer login)', () => {
  test('login purpose 404s for a mobile with no farmer account', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/auth/request-otp').send({ mobile: '9876543210', purpose: 'login' });
    expect(res.status).toBe(404);
  });

  test('sends and logs a code, and dev mode echoes it back', async () => {
    const { app, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, { phone: '9876543210' });

    const res = await request(app).post('/api/auth/request-otp').send({ mobile: '9876543210', purpose: 'login' });
    expect(res.status).toBe(200);
    expect(res.body.devCode).toMatch(/^\d{6}$/);

    const messages = await pool.query('SELECT farmer_id, mobile, channel, body FROM messages WHERE mobile = $1', ['9876543210']);
    expect(messages.rowCount).toBe(1);
    expect(messages.rows[0].farmer_id).toBe(farmerId);
    expect(messages.rows[0].body).toContain(res.body.devCode);
  });

  test('a wrong code is rejected; the right one logs the farmer in', async () => {
    const { app, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, { phone: '9876543210', farmerName: 'Ravi Kumar' });

    const sent = await request(app).post('/api/auth/request-otp').send({ mobile: '9876543210', purpose: 'login' });
    const code = sent.body.devCode;

    const wrong = await request(app).post('/api/auth/verify-otp').send({ mobile: '9876543210', code: '000000', purpose: 'login' });
    expect(wrong.status).toBe(400);

    const agent = request.agent(app);
    const right = await agent.post('/api/auth/verify-otp').send({ mobile: '9876543210', code, purpose: 'login' });
    expect(right.status).toBe(200);
    expect(right.body.role).toBe('farmer');
    expect(right.body.farmerId).toBe(farmerId);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('farmer');
    expect(me.body.farmerId).toBe(farmerId);
  });

  test('a code cannot be reused (single-use)', async () => {
    const { app, pool } = setup();
    await insertFarmerWithLand(pool, { phone: '9876543210' });
    const sent = await request(app).post('/api/auth/request-otp').send({ mobile: '9876543210', purpose: 'login' });
    const code = sent.body.devCode;

    const first = await request(app).post('/api/auth/verify-otp').send({ mobile: '9876543210', code, purpose: 'login' });
    expect(first.status).toBe(200);

    const replay = await request(app).post('/api/auth/verify-otp').send({ mobile: '9876543210', code, purpose: 'login' });
    expect(replay.status).toBe(400);
  });

  test('registration purpose 409s for a mobile that already has a farmer account', async () => {
    const { app, pool } = setup();
    await insertFarmerWithLand(pool, { phone: '9876543210' });
    const res = await request(app).post('/api/auth/request-otp').send({ mobile: '9876543210', purpose: 'registration' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/login (officers/operators)', () => {
  test('valid credentials log in and /me reflects role + scope', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertEmployee(pool, { employeeId: 'CO-100', password: 'correct-horse', role: 'centre_officer', centreId });

    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ employeeId: 'CO-100', password: 'correct-horse' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('centre_officer');
    expect(res.body.centreId).toBe(centreId);

    const me = await agent.get('/api/auth/me');
    expect(me.body.role).toBe('centre_officer');
    expect(me.body.centreId).toBe(centreId);
  });

  test('wrong password is rejected with the same message as an unknown employee id', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertEmployee(pool, { employeeId: 'CO-100', password: 'correct-horse', centreId });

    const wrongPassword = await request(app).post('/api/auth/login').send({ employeeId: 'CO-100', password: 'nope' });
    const unknownId = await request(app).post('/api/auth/login').send({ employeeId: 'NOPE-1', password: 'nope' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownId.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownId.body.message);
  });

  test('correct credentials but the wrong role selected on the form is rejected, naming the real role', async () => {
    const { app, pool } = setup();
    await insertEmployee(pool, { employeeId: 'DO-001', password: 'correct-horse', role: 'district_officer', district: 'Medak' });

    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ employeeId: 'DO-001', password: 'correct-horse', role: 'centre_officer' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('ROLE_MISMATCH');
    expect(res.body.message).toBe('DO-001 is a district officer account. Select District officer to continue.');

    // Not logged in -- no session was established.
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  test('selecting the matching role logs in as usual', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertEmployee(pool, { employeeId: 'CO-100', password: 'correct-horse', role: 'centre_officer', centreId });

    const res = await request(app).post('/api/auth/login').send({ employeeId: 'CO-100', password: 'correct-horse', role: 'centre_officer' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('centre_officer');
  });

  describe('lockout after repeated failed attempts', () => {
    test('the 11th failed attempt within the window is locked out, not just another 401', async () => {
      const { app, pool } = setup();
      const centreId = await insertCentre(pool);
      await insertEmployee(pool, { employeeId: 'CO-LOCK-001', password: 'correct-horse', centreId });

      let last;
      for (let i = 0; i < 10; i++) {
        last = await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-001', password: 'wrong' });
        expect(last.status).toBe(401);
      }

      const eleventh = await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-001', password: 'wrong' });
      expect(eleventh.status).toBe(429);
      expect(eleventh.body.status).toBe('TOO_MANY_ATTEMPTS');
    });

    test('a locked-out account is refused even with the correct password', async () => {
      const { app, pool } = setup();
      const centreId = await insertCentre(pool);
      await insertEmployee(pool, { employeeId: 'CO-LOCK-002', password: 'correct-horse', centreId });

      for (let i = 0; i < 10; i++) {
        await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-002', password: 'wrong' });
      }

      const res = await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-002', password: 'correct-horse' });
      expect(res.status).toBe(429);
    });

    test('failed attempts against one employee id do not lock out another', async () => {
      const { app, pool } = setup();
      const centreId = await insertCentre(pool);
      await insertEmployee(pool, { employeeId: 'CO-LOCK-003', password: 'correct-horse', centreId });
      await insertEmployee(pool, { employeeId: 'CO-LOCK-004', password: 'also-correct', centreId });

      for (let i = 0; i < 10; i++) {
        await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-003', password: 'wrong' });
      }

      const res = await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-004', password: 'also-correct' });
      expect(res.status).toBe(200);
    });

    test('a successful login before the threshold resets the count for that account', async () => {
      const { app, pool } = setup();
      const centreId = await insertCentre(pool);
      await insertEmployee(pool, { employeeId: 'CO-LOCK-005', password: 'correct-horse', centreId });

      for (let i = 0; i < 9; i++) {
        await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-005', password: 'wrong' });
      }
      const success = await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-005', password: 'correct-horse' });
      expect(success.status).toBe(200);

      // Another 9 failures right after -- if the earlier near-miss count
      // had carried over, this 9th would already be the account's 18th
      // failure and it'd already be locked; it shouldn't be.
      let last;
      for (let i = 0; i < 9; i++) {
        last = await request(app).post('/api/auth/login').send({ employeeId: 'CO-LOCK-005', password: 'wrong' });
      }
      expect(last.status).toBe(401);
    });
  });
});

describe('POST /api/farmers/register', () => {
  async function verifiedRegAgent(app, mobile) {
    const agent = request.agent(app);
    const sent = await agent.post('/api/auth/request-otp').send({ mobile, purpose: 'registration' });
    await agent.post('/api/auth/verify-otp').send({ mobile, code: sent.body.devCode, purpose: 'registration' });
    return agent;
  }

  test('rejects registration without a verified mobile', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/farmers/register')
      .send({ name: 'New Farmer', mobile: '9876500001' });
    expect(res.status).toBe(400);
  });

  test('replaying the same Idempotency-Key returns the original registration, not a duplicate-mobile conflict', async () => {
    const { app } = setup();
    const agent = await verifiedRegAgent(app, '9876500099');

    const first = await agent
      .post('/api/farmers/register')
      .set('Idempotency-Key', 'reg-key-1')
      .send({ name: 'Replay Farmer', mobile: '9876500099' });
    expect(first.status).toBe(201);

    // Simulates the offline outbox (public/offline-queue.js) replaying a
    // queued registration after reconnecting, having never seen the
    // first response -- without idempotency this would 409 on the
    // now-taken mobile number instead of returning the same farmerId.
    const replay = await agent
      .post('/api/farmers/register')
      .set('Idempotency-Key', 'reg-key-1')
      .send({ name: 'Replay Farmer', mobile: '9876500099' });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  test('a khasra matching a land record under the same name registers as verified', async () => {
    const { app, pool } = setup();
    await insertLandRecord(pool, { landRecordNumber: 'KH-1024', farmerName: 'Suresh Naik', extentAcres: 4 });
    const agent = await verifiedRegAgent(app, '9876500002');

    const res = await agent.post('/api/farmers/register').send({
      name: 'Suresh Naik', mobile: '9876500002', khasra: 'kh-1024',
    });

    expect(res.status).toBe(201);
    expect(res.body.verified).toBe(true);
    expect(res.body.needsOfficerReview).toBe(false);

    const row = await pool.query('SELECT land_record_id, is_tenant FROM farmers WHERE id = $1', [res.body.farmerId]);
    expect(row.rows[0].land_record_id).not.toBeNull();
    expect(row.rows[0].is_tenant).toBe(false);
  });

  test('a khasra matching a land record under a DIFFERENT name registers as a tenant needing review', async () => {
    const { app, pool } = setup();
    await insertLandRecord(pool, { landRecordNumber: 'KH-2048', farmerName: 'Owner Name' });
    const agent = await verifiedRegAgent(app, '9876500003');

    const res = await agent.post('/api/farmers/register').send({
      name: 'Cultivator Name', mobile: '9876500003', khasra: 'KH-2048',
    });

    expect(res.status).toBe(201);
    expect(res.body.isTenant).toBe(true);
    expect(res.body.needsOfficerReview).toBe(true);
  });

  test('a khasra matching nothing still registers -- not a rejection -- flagged for officer review', async () => {
    const { app, pool } = setup();
    const agent = await verifiedRegAgent(app, '9876500004');

    const res = await agent.post('/api/farmers/register').send({
      name: 'No Match Farmer', mobile: '9876500004', khasra: 'KH-9999-DOES-NOT-EXIST',
      landSizeAcres: 3, crop: 'Paddy',
    });

    expect(res.status).toBe(201);
    expect(res.body.verified).toBe(false);
    expect(res.body.needsOfficerReview).toBe(true);

    const row = await pool.query(
      'SELECT land_record_id, claimed_land_record_number, claimed_extent_acres FROM farmers WHERE id = $1',
      [res.body.farmerId]
    );
    expect(row.rows[0].land_record_id).toBeNull();
    expect(row.rows[0].claimed_land_record_number).toBe('KH-9999-DOES-NOT-EXIST');
    expect(Number(row.rows[0].claimed_extent_acres)).toBe(3);

    // Exactly the existing needsOfficerReview("no land record") gate --
    // GET /api/farmers/:id agrees.
    const officerAgent = districtOfficerAgent(app);
    const detail = await officerAgent.get(`/api/farmers/${res.body.farmerId}`);
    expect(detail.body.needsOfficerReview).toBe(true);
    expect(detail.body.hasLandRecord).toBe(false);
  });

  test('an assisted registration by a logged-in operator stamps the operator for audit', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const operatorDbId = await insertEmployee(pool, { role: 'operator', centreId, employeeId: 'OP-100' });
    const agent = await verifiedRegAgent(app, '9876500005');
    // Layer the operator's own session on top of the registration-verified
    // cookie -- both are independent cookies on the same agent.
    const opToken = signToken({ role: 'operator', employeeDbId: operatorDbId, centreId, name: 'Op' });
    agent.jar.setCookie(cookiejar.Cookie(`${COOKIE_NAME}=${opToken}; Path=/`));

    const res = await agent.post('/api/farmers/register').send({ name: 'Assisted Farmer', mobile: '9876500005' });

    expect(res.status).toBe(201);
    expect(res.body.assistedByOperator).toBe(true);
    const row = await pool.query('SELECT registered_by_operator_id, registered_channel FROM farmers WHERE id = $1', [res.body.farmerId]);
    expect(row.rows[0].registered_by_operator_id).toBe(operatorDbId);
    expect(row.rows[0].registered_channel).toBe('counter');
  });

  test('a mobile that becomes a farmer between OTP verification and submission is rejected with 409, not a raw DB error', async () => {
    const { app, pool } = setup();
    // Verify OTP for a mobile that has no farmer yet -- request-otp would
    // itself have refused this mobile had a farmer already existed at
    // that point, so this exercises register's own redundant defense
    // against the race where one appears in between (or a direct API
    // call skipping the normal flow).
    const agent = await verifiedRegAgent(app, '9876500006');
    await insertFarmerWithLand(pool, { phone: '9876500006' });

    const res = await agent.post('/api/farmers/register').send({ name: 'Duplicate', mobile: '9876500006' });
    expect(res.status).toBe(409);
  });

  describe('field validation', () => {
    test('rejects a name with digits, no vowels, or 4+ repeated characters', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500010');

      const withDigits = await agent.post('/api/farmers/register').send({ name: 'Ravi123', mobile: '9876500010' });
      expect(withDigits.status).toBe(400);

      const noVowels = await agent.post('/api/farmers/register').send({ name: 'Krtvv', mobile: '9876500010' });
      expect(noVowels.status).toBe(400);

      const repeated = await agent.post('/api/farmers/register').send({ name: 'Raaaavi', mobile: '9876500010' });
      expect(repeated.status).toBe(400);
    });

    test('accepts a mobile number with a +91 prefix, spaces and hyphens, normalizing before storing', async () => {
      const { app, pool } = setup();
      const agent = await verifiedRegAgent(app, '9876500011');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Prefixed Mobile', mobile: '+91 98765-00011' });

      expect(res.status).toBe(201);
      const row = await pool.query('SELECT phone FROM farmers WHERE id = $1', [res.body.farmerId]);
      expect(row.rows[0].phone).toBe('9876500011');
    });

    test('rejects a mobile number that is all the same digit', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '7777777777');

      const res = await agent.post('/api/farmers/register').send({ name: 'All Same', mobile: '7777777777' });
      expect(res.status).toBe(400);
    });

    test('rejects an Aadhaar number that fails the Verhoeff checksum', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500012');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Bad Aadhaar', mobile: '9876500012', aadhaar: '234567890123' });
      expect(res.status).toBe(400);
      expect(res.body.errors.join(' ')).toMatch(/checksum/);
    });

    test('accepts an Aadhaar number with a valid Verhoeff checksum', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500013');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Good Aadhaar', mobile: '9876500013', aadhaar: '234567890124' });
      expect(res.status).toBe(201);
    });

    test('rejects an Aadhaar number starting with 0 or 1', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500014');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Leading Digit', mobile: '9876500014', aadhaar: '134567890128' });
      expect(res.status).toBe(400);
    });

    test('rejects a malformed khasra number', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500015');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Bad Khasra', mobile: '9876500015', khasra: 'K$' });
      expect(res.status).toBe(400);
    });

    test('land size 100-1000 acres registers but is flagged for officer review, even for an otherwise-verified match', async () => {
      const { app, pool } = setup();
      await insertLandRecord(pool, { landRecordNumber: 'KH-BIG-01', farmerName: 'Big Farmer', extentAcres: 4 });
      const agent = await verifiedRegAgent(app, '9876500016');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Big Farmer', mobile: '9876500016', khasra: 'KH-BIG-01', landSizeAcres: 500 });

      expect(res.status).toBe(201);
      expect(res.body.verified).toBe(true); // the khasra match itself is clean
      expect(res.body.needsOfficerReview).toBe(true); // but the claimed 500-acre size still needs a human look
    });

    test('land size above 1000 acres is rejected outright', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500017');

      const res = await agent
        .post('/api/farmers/register')
        .send({ name: 'Too Big', mobile: '9876500017', khasra: 'KH-9999-NONE', landSizeAcres: 1500 });

      expect(res.status).toBe(400);
    });

    test('rejects a bank account number outside 9-18 digits', async () => {
      const { app } = setup();
      const agent = await verifiedRegAgent(app, '9876500018');

      const tooShort = await agent
        .post('/api/farmers/register')
        .send({ name: 'Short Account', mobile: '9876500018', bankAccountNumber: '12345' });
      expect(tooShort.status).toBe(400);
      expect(tooShort.body.errors.join(' ')).toMatch(/9-18/);

      const agent2 = await verifiedRegAgent(app, '9876500021');
      const tooLong = await agent2
        .post('/api/farmers/register')
        .send({ name: 'Long Account', mobile: '9876500021', bankAccountNumber: '12345678901234567890' }); // 20 digits
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.errors.join(' ')).toMatch(/9-18/);
    });

    test('accepts a bank account number at each boundary (9 and 18 digits)', async () => {
      const { app } = setup();

      const agentMin = await verifiedRegAgent(app, '9876500022');
      const min = await agentMin
        .post('/api/farmers/register')
        .send({ name: 'Min Account', mobile: '9876500022', bankAccountNumber: '123456789' }); // 9 digits
      expect(min.status).toBe(201);

      const agentMax = await verifiedRegAgent(app, '9876500023');
      const max = await agentMax
        .post('/api/farmers/register')
        .send({ name: 'Max Account', mobile: '9876500023', bankAccountNumber: '123456789012345678' }); // 18 digits
      expect(max.status).toBe(201);
    });

    test('uppercases a lowercase IFSC before storing, and rejects a malformed one', async () => {
      const { app, pool } = setup();
      const agent = await verifiedRegAgent(app, '9876500019');

      const ok = await agent
        .post('/api/farmers/register')
        .send({ name: 'Lower Ifsc', mobile: '9876500019', bankIfsc: 'sbin0001234' });
      expect(ok.status).toBe(201);
      const row = await pool.query('SELECT bank_ifsc FROM farmers WHERE id = $1', [ok.body.farmerId]);
      expect(row.rows[0].bank_ifsc).toBe('SBIN0001234');

      const agent2 = await verifiedRegAgent(app, '9876500020');
      const bad = await agent2
        .post('/api/farmers/register')
        .send({ name: 'Bad Ifsc', mobile: '9876500020', bankIfsc: 'SBIN123' });
      expect(bad.status).toBe(400);
    });
  });
});

describe('GET /api/land-records/lookup', () => {
  test('returns the record on a match', async () => {
    const { app, pool } = setup();
    await insertLandRecord(pool, { landRecordNumber: 'KH-3300', farmerName: 'Match Name', extentAcres: 2.5 });
    const res = await request(app).get('/api/land-records/lookup').query({ number: 'KH-3300' });
    expect(res.status).toBe(200);
    expect(res.body.farmerName).toBe('Match Name');
    expect(res.body.extentAcres).toBe(2.5);
  });

  test('404s on no match', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/land-records/lookup').query({ number: 'KH-NOPE' });
    expect(res.status).toBe(404);
  });
});

describe('role-based access denial', () => {
  test('a farmer cannot read another farmer\'s J-Form, but can read their own', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const farmerA = await insertFarmerWithLand(pool, { extentAcres: 5 });
    const farmerB = await insertFarmerWithLand(pool, { extentAcres: 5 });
    await fullyProcessedBooking(pool, { farmerId: farmerA, centreId });

    const agentA = farmerAgent(app, farmerA);
    const agentB = farmerAgent(app, farmerB);

    const ownRead = await agentA.get(`/api/farmers/${farmerA}/jform`);
    expect(ownRead.status).not.toBe(403); // 404 (no J-Form issued yet) is fine -- the point is it's not FORBIDDEN

    const crossRead = await agentB.get(`/api/farmers/${farmerA}/jform`);
    expect(crossRead.status).toBe(403);
    expect(crossRead.body.status).toBe('FORBIDDEN');

    const unauth = await request(app).get(`/api/farmers/${farmerA}/jform`);
    expect(unauth.status).toBe(401);
  });

  test('a farmer cannot read another farmer\'s status or profile either', async () => {
    const { app, pool } = setup();
    const farmerA = await insertFarmerWithLand(pool, {});
    const farmerB = await insertFarmerWithLand(pool, {});
    const agentB = farmerAgent(app, farmerB);

    const status = await agentB.get(`/api/farmers/${farmerA}/status`);
    expect(status.status).toBe(403);

    const profile = await agentB.get(`/api/farmers/${farmerA}`);
    expect(profile.status).toBe(403);
  });

  test('a farmer session cannot list the whole farmer roster', async () => {
    const { app, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, {});
    const res = await farmerAgent(app, farmerId).get('/api/farmers');
    expect(res.status).toBe(403);
  });

  test('an officer/operator may read any farmer\'s records (oversight, not self-only)', async () => {
    const { app, pool } = setup();
    const farmerId = await insertFarmerWithLand(pool, {});
    const res = await districtOfficerAgent(app).get(`/api/farmers/${farmerId}`);
    expect(res.status).toBe(200);
  });

  test('a farmer cannot book on another farmer\'s behalf', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerA = await insertFarmerWithLand(pool, { extentAcres: 5 });
    const farmerB = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const res = await farmerAgent(app, farmerA)
      .post('/api/bookings')
      .send({ farmerId: farmerB, quintals: 10, centreId, date: DATE });

    expect(res.status).toBe(403);
  });

  test('a centre officer cannot declare for a centre that isn\'t theirs, but can for their own', async () => {
    const { app, pool } = setup();
    const ownCentre = await insertCentre(pool);
    const otherCentre = await insertCentre(pool);
    const officer = centreOfficerAgent(app, ownCentre);

    const declarationBody = {
      date: DATE, weighingMode: 'weighbridge', weighbridgeOperatingMinutes: 480, weighbridgeAvgCycleMinutes: 8,
      hamaliGangCount: 10, hamaliBagsPerGangPerDay: 600, bagsPerTruck: 100, gunnyBagsAvailable: 6000,
      truckEvacuationCapacity: 60, yardCapacityTonnes: 600, undispatchedTonnes: 0, avgTruckLoadTonnes: 10,
      moistureMeterCount: 5, moistureTestsPerMeterPerDay: 100,
    };

    const denied = await officer.post(`/api/centres/${otherCentre}/declaration`).send(declarationBody);
    expect(denied.status).toBe(403);

    const allowed = await officer.post(`/api/centres/${ownCentre}/declaration`).send(declarationBody);
    expect(allowed.status).toBe(200);
  });

  test('a district officer from a different district cannot declare for this district\'s centre', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool, { district: 'Medak' });
    const outsider = districtOfficerAgent(app, 'SomeOtherDistrict');

    const res = await outsider.get(`/api/centres/${centreId}/declaration`).query({ date: DATE });
    expect(res.status).toBe(403);
  });

  test('the district dashboard is district_officer-only', async () => {
    const { app, pool } = setup();
    await insertCentre(pool);

    const farmerId = await insertFarmerWithLand(pool, {});
    const asFarmer = await farmerAgent(app, farmerId).get('/api/dashboard').query({ date: DATE });
    expect(asFarmer.status).toBe(403);

    const asCentreOfficer = await centreOfficerAgent(app, 'some-centre').get('/api/dashboard').query({ date: DATE });
    expect(asCentreOfficer.status).toBe(403);

    const asDistrictOfficer = await districtOfficerAgent(app).get('/api/dashboard').query({ date: DATE });
    expect(asDistrictOfficer.status).toBe(200);
  });

  test('the dashboard only shows centres in the officer\'s own district', async () => {
    const { app, pool } = setup();
    const medakCentre = await insertCentre(pool, { name: 'Medak Centre', code: 'MED-01', district: 'Medak' });
    await insertDailyInputs(pool, { centreId: medakCentre, serviceDate: DATE });
    const otherCentre = await insertCentre(pool, { name: 'Other Centre', code: 'OTH-01', district: 'OtherDistrict' });
    await insertDailyInputs(pool, { centreId: otherCentre, serviceDate: DATE });

    const res = await districtOfficerAgent(app, 'Medak').get('/api/dashboard').query({ date: DATE });
    expect(res.status).toBe(200);
    expect(res.body.centres.map((c) => c.code)).toEqual(['MED-01']);
  });

  test('lot workflow actions are centre-scoped: wrong centre officer is denied, own centre is allowed', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    const otherCentreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, {});
    const bookingId = await insertBooking(pool, { centreDayId, farmerId, token: 'TOK-1' });

    const wrongOfficer = centreOfficerAgent(app, otherCentreId);
    const denied = await wrongOfficer.post(`/api/lots/${bookingId}/checkin`).send({ token: 'TOK-1' });
    expect(denied.status).toBe(403);

    const rightOfficer = centreOfficerAgent(app, centreId);
    const allowed = await rightOfficer.post(`/api/lots/${bookingId}/checkin`).send({ token: 'TOK-1' });
    expect(allowed.status).toBe(200);
  });
});

describe('POST /api/auth/demo-login', () => {
  test('logs in as a demo farmer, and as each employee role, when one exists', async () => {
    const { app, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertFarmerWithLand(pool, { extentAcres: 3, isTenant: false });
    await insertEmployee(pool, { role: 'centre_officer', centreId });
    await insertEmployee(pool, { role: 'district_officer', district: 'Medak' });
    await insertEmployee(pool, { role: 'operator', centreId });

    for (const role of ['farmer', 'centre_officer', 'district_officer', 'operator']) {
      const res = await request(app).post('/api/auth/demo-login').send({ role });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe(role);
    }
  });

  test('404s for a role with no demo account/farmer available', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/auth/demo-login').send({ role: 'district_officer' });
    expect(res.status).toBe(404);
  });
});
