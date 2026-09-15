'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { attemptBooking, findAlternatives } = require('./bookingService');
const { computeCentreDayCapacity, computeRemainingSlots } = require('./capacityService');
const { createLotRoutes } = require('./lotRoutes');
const { createDeclarationRoutes } = require('./declarationRoutes');
const { createDashboardRoutes } = require('./dashboardRoutes');
const { createFarmerRoutes } = require('./farmerRoutes');
const { createAuthRoutes } = require('./authRoutes');
const { requireAuth } = require('./authMiddleware');
const { validateQuantity, validateBookingDate } = require('../public/validation');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Centres operate on India's calendar day, not the host machine's -- a
// server left in its default UTC timezone (typical for a cloud VM) would
// otherwise think "today" is still yesterday for the first 5.5 hours of
// every IST day, letting past-dated bookings through. Deriving the date
// from an IST-shifted instant sidesteps the host's TZ setting entirely.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function todayInIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

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

// `now` is injectable so tests aren't at the mercy of the wall clock --
// mirrors the `today` override on runNightlyReallocation.
function createApp(pool, { now = todayInIST } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

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

  app.use('/api/lots', createLotRoutes(pool));
  app.use('/api', createDeclarationRoutes(pool));
  app.use('/api', createDashboardRoutes(pool));
  app.use('/api', createFarmerRoutes(pool));

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
