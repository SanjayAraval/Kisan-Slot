'use strict';

const path = require('path');
const express = require('express');
const { attemptBooking, findAlternatives } = require('./bookingService');
const { computeCentreDayCapacity } = require('./capacityService');
const { createLotRoutes } = require('./lotRoutes');
const { createDeclarationRoutes } = require('./declarationRoutes');
const { createDashboardRoutes } = require('./dashboardRoutes');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validateBookingBody(body) {
  const errors = [];
  if (!isNonEmptyString(body.farmerId)) errors.push('farmerId is required');
  if (!isNonEmptyString(body.centreId)) errors.push('centreId is required');
  if (!isNonEmptyString(body.date) || !DATE_RE.test(body.date)) errors.push('date is required as YYYY-MM-DD');
  if (typeof body.quintals !== 'number' || !Number.isFinite(body.quintals) || body.quintals <= 0) {
    errors.push('quintals must be a positive number');
  }
  return errors;
}

function createApp(pool) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.post('/api/bookings', async (req, res, next) => {
    const errors = validateBookingBody(req.body || {});
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
      let bagsBooked;
      try {
        capacity = await computeCentreDayCapacity(client, centreId, date);
        if (!capacity) {
          return res.status(404).json({ status: 'NOT_FOUND', message: 'centre has no operating data for this date' });
        }
        const existing = await client.query(
          'SELECT bags_booked FROM centre_day WHERE centre_id = $1 AND service_date = $2',
          [centreId, date]
        );
        bagsBooked = existing.rows[0] ? Number(existing.rows[0].bags_booked) : 0;
      } finally {
        client.release();
      }

      const remainingBags = capacity.bagsCapacity - bagsBooked;
      const remainingSlots = Math.floor(remainingBags / capacity.bagsPerTruck);

      return res.status(200).json({
        centreId,
        date,
        capacity: capacity.engineResult.totalCapacity,
        bookableSlots: capacity.engineResult.bookableCapacity,
        remaining: Math.max(0, remainingSlots),
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

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ status: 'ERROR', message: err.message });
  });

  return app;
}

module.exports = { createApp };
