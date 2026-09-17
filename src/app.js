'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { attemptBooking, findAlternatives } = require('./bookingService');
const { computeCentreDayCapacity, computeRemainingSlots } = require('./capacityService');
const { createLotRoutes } = require('./lotRoutes');
const { createQueueRoutes } = require('./queueRoutes');
const { createDeclarationRoutes } = require('./declarationRoutes');
const { createDashboardRoutes } = require('./dashboardRoutes');
const { createFarmerRoutes } = require('./farmerRoutes');
const { createAuthRoutes } = require('./authRoutes');
const { createAdminRoutes } = require('./adminRoutes');
const { requireAuth } = require('./authMiddleware');
const { validateQuantity, validateBookingDate } = require('../public/validation');
const { todayInIST } = require('./todayInIST');
const { idempotentReplay, recordIdempotentResponse } = require('./idempotency');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isValidId(v) {
  return isNonEmptyString(v) && UUID_RE.test(v);
}

function validateBookingBody(body, today) {
  const errors = [];
  if (!isValidId(body.farmerId)) errors.push('farmerId is required and must be a valid id');
  if (!isValidId(body.centreId)) errors.push('centreId is required and must be a valid id');

  const dateErr = validateBookingDate(body.date, today);
  if (dateErr) errors.push(dateErr);

  if (typeof body.quintals !== 'number' || !Number.isFinite(body.quintals)) {
    errors.push('quintals must be a positive number');
  } else {
    const quantityErr = validateQuantity(body.quintals);
    if (quantityErr) errors.push(quantityErr);
  }
  return errors;
}

// The default CSP (script-src/connect-src 'self' only) would block every
// page in public/ -- they all load React, QR libraries and Tailwind's
// Play CDN from unpkg/cdnjs/cdn.tailwindcss.com as inline <script> blocks
// (no bundler -- see CLAUDE.md's stack note), and farmer.html's rain
// advisory calls Open-Meteo directly from the browser. Everything else
// (frame-ancestors, object-src, the COOP/CORP/HSTS headers, etc.) stays
// at helmet's default, already-strict setting.
const CSP_SCRIPT_SOURCES = ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.tailwindcss.com'];
// Same CDN hosts as script-src, plus Open-Meteo -- connect-src (not
// script-src) is what governs fetch()/XHR, which covers both
// farmer.html's rain-advisory call *and* sw.js's own runtime-caching
// fetches for those CDN assets (see public/sw.js's RUNTIME_CACHE_HOSTS --
// a service worker's fetches are governed by the CSP its own script was
// served with, same as the page that registered it).
const CSP_CONNECT_SOURCES = ["'self'", 'https://api.open-meteo.com', 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.tailwindcss.com'];

// Blanket protection against a client hammering any endpoint -- separate
// from loginRateLimiter.js, which tracks failed /api/auth/login attempts
// per employeeId rather than requests per IP.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// `now` is injectable so tests aren't at the mercy of the wall clock --
// mirrors the `today` override on runNightlyReallocation.
function createApp(pool, { now = todayInIST } = {}) {
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': CSP_SCRIPT_SOURCES,
          'connect-src': CSP_CONNECT_SOURCES,
          'worker-src': ["'self'"],
        },
      },
    })
  );
  app.use(globalLimiter);
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => res.redirect('/login.html'));

  app.use('/api/auth', createAuthRoutes(pool));

  // Booking is a farmer acting for themselves, or an operator assisting
  // one -- never an officer, and never a farmer booking as someone else.
  app.post('/api/bookings', requireAuth, (req, res, next) => {
    if (req.user.role === 'farmer' && req.body && req.body.farmerId !== req.user.farmerId) {
      return res.status(403).json({ status: 'FORBIDDEN', message: 'farmers may only book for themselves' });
    }
    if (req.user.role !== 'farmer' && req.user.role !== 'operator') {
      return res.status(403).json({ status: 'FORBIDDEN', message: 'only farmers and assisted operators can create bookings' });
    }
    next();
  }, async (req, res, next) => {
    // Placed after the role/self checks above, so replaying a stale key
    // still requires the same authorization the original request needed
    // -- see idempotency.js.
    if (await idempotentReplay(pool, req, res)) return;
    recordIdempotentResponse(pool, req, res);

    const errors = validateBookingBody(req.body || {}, now());
    if (errors.length > 0) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors });
    }
    const { farmerId, quintals, centreId, date } = req.body;

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await attemptBooking(client, { farmerId, quintals, centreId, date });
      if (result.type === 'BOOKED') {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return next(err);
    }
    client.release();

    switch (result.type) {
      case 'BOOKED':
        return res.status(201).json({ status: 'BOOKED', booking: result.booking, remainingBags: result.remainingBags, remainingSlots: result.remainingSlots });

      case 'NEEDS_OFFICER_REVIEW':
        return res.status(200).json({ status: 'NEEDS_OFFICER_REVIEW', reason: result.reason, message: result.message, landEstimateQuintals: result.landEstimateQuintals, requestedQuintals: result.requestedQuintals });

      case 'NOT_FOUND':
        return res.status(404).json({ status: 'NOT_FOUND', message: result.message });

      case 'ALREADY_BOOKED':
        return res.status(409).json({ status: 'ALREADY_BOOKED', message: result.message });

      case 'NO_CAPACITY': {
        const alternatives = await findAlternatives(pool, { centreId, date, bagsNeeded: result.bagsNeeded });
        return res.status(200).json({ status: 'NO_CAPACITY', message: result.message, alternatives });
      }

      default:
        return next(new Error(`unhandled booking result type: ${result.type}`));
    }
  });

  app.get('/api/centres/:id/availability', async (req, res, next) => {
    const centreId = req.params.id;
    const { date } = req.query;
    if (!isNonEmptyString(date) || !DATE_RE.test(date)) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors: ['date query param is required as YYYY-MM-DD'] });
    }

    try {
      const client = await pool.connect();
      let capacity;
      let remaining;
      try {
        capacity = await computeCentreDayCapacity(client, centreId, date);
        if (!capacity) {
          const centreResult = await client.query('SELECT id FROM centres WHERE id = $1', [centreId]);
          if (!centreResult.rows[0]) {
            return res.status(404).json({ status: 'NOT_FOUND', message: 'centre not found' });
          }
          return res.status(404).json({
            status: 'NOT_FOUND',
            message: `No procurement capacity has been declared for this centre on ${date} yet -- try a different date.`,
          });
        }
        // Re-derives the same capacity computeCentreDayCapacity just did --
        // an extra query, but this endpoint isn't hot enough to warrant
        // threading a pre-computed value through computeRemainingSlots's
        // signature just to save it.
        remaining = await computeRemainingSlots(client, centreId, date);
      } finally {
        client.release();
      }

      return res.status(200).json({
        centreId,
        date,
        capacity: capacity.engineResult.totalCapacity,
        bookableSlots: capacity.engineResult.bookableCapacity,
        remaining: remaining.remaining,
        bindingConstraint: capacity.engineResult.bindingConstraint,
        constraints: capacity.engineResult.constraints,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.use('/api/lots', createLotRoutes(pool, { now }));
  app.use('/api', createQueueRoutes(pool));
  app.use('/api', createDeclarationRoutes(pool));
  app.use('/api', createDashboardRoutes(pool));
  app.use('/api', createFarmerRoutes(pool));
  app.use('/api', createAdminRoutes(pool));

  // Catch-all for anything a route didn't already turn into a specific,
  // farmer-facing status (404/409/400 etc). Never forwards the raw error
  // (a Postgres message like "numeric field overflow" means nothing to a
  // farmer) -- log it for an operator to investigate and answer with a
  // generic message instead.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ status: 'ERROR', message: 'Something went wrong on our end. Please try again.' });
  });

  return app;
}

module.exports = { createApp, todayInIST };
