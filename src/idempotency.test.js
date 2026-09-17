'use strict';

const request = require('supertest');
const { createApp } = require('./app');
const { createTestPool } = require('./testUtils/pgMemDb');
const { insertCentre, insertDailyInputs, insertFarmerWithLand } = require('./testUtils/fixtures');
const { operatorAgent } = require('./testUtils/authTestHelpers');

const DATE = '2026-09-04';

function setup() {
  const pool = createTestPool();
  const app = createApp(pool, { now: () => DATE });
  const agent = operatorAgent(app);
  return { pool, app, agent };
}

// Cross-cutting behavior of src/idempotency.js that isn't tied to any one
// route -- per-route replay tests (booking, registration, gate scan) live
// alongside those routes' other tests.
describe('Idempotency-Key handling', () => {
  test('reusing a key against a different route is rejected, not replayed', async () => {
    const { agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const booking = await agent
      .post('/api/bookings')
      .set('Idempotency-Key', 'shared-key')
      .send({ farmerId, quintals: 10, centreId, date: DATE });
    expect(booking.status).toBe(201);

    // OTP-verify a second mobile number on the same agent so this
    // request clears registration's own auth gate and actually reaches
    // the idempotency check below (which sits after that gate -- see
    // farmerRoutes.js) rather than failing earlier for an unrelated
    // reason.
    const sent = await agent.post('/api/auth/request-otp').send({ mobile: '9876512345', purpose: 'registration' });
    await agent.post('/api/auth/verify-otp').send({ mobile: '9876512345', code: sent.body.devCode, purpose: 'registration' });

    // Same key, reused against a completely different endpoint -- must
    // never hand back the booking response (or run the register logic
    // and silently succeed); the mismatch itself is the point.
    const registration = await agent
      .post('/api/farmers/register')
      .set('Idempotency-Key', 'shared-key')
      .send({ name: 'Someone Else', mobile: '9876512345' });
    expect(registration.status).toBe(422);
  });

  test('a request with no Idempotency-Key header is never intercepted', async () => {
    const { agent, pool } = setup();
    const centreId = await insertCentre(pool);
    await insertDailyInputs(pool, { centreId, serviceDate: DATE });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 5 });

    const first = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });
    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    // No key on either request -- ordinary "already booked" behavior,
    // completely unaffected by idempotency handling.
    const second = await agent.post('/api/bookings').send({ farmerId, quintals: 10, centreId, date: DATE });
    expect(second.status).toBe(409);
  });
});

describe('security headers (Helmet)', () => {
  test('every response carries Helmet\'s baseline headers, with a CSP that still allows the app\'s own CDN scripts', async () => {
    const pool = createTestPool();
    const app = createApp(pool);

    const res = await request(app).get('/api/auth/me');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com");
    expect(res.headers['content-security-policy']).toContain('https://api.open-meteo.com');
  });
});
