'use strict';

const express = require('express');
const { checkinLot, recordQuality, recordWeighment, issueJForm, recordDispatch } = require('./lotService');
const { requireAuth, requireBookingCentreScope } = require('./authMiddleware');

const STATUS_BY_RESULT_TYPE = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  BAD_REQUEST: 400,
};

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Runs `fn(client, bookingId, body)` inside one transaction, committing
// only on a successful ('OK') result -- every other outcome (not found,
// conflicting lot state, bad input) rolls back and maps to its HTTP
// status via STATUS_BY_RESULT_TYPE.
function lotAction(pool, fn, successStatus) {
  return async (req, res, next) => {
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await fn(client, req.params.id, req.body || {});
      await client.query(result.type === 'OK' ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return next(err);
    }
    client.release();

    if (result.type === 'OK') {
      const { type, ...body } = result;
      return res.status(successStatus).json({ status: 'OK', ...body });
    }
    const httpStatus = STATUS_BY_RESULT_TYPE[result.type] || 500;
    return res.status(httpStatus).json({ status: result.type, message: result.message });
  };
}

function createLotRoutes(pool) {
  const router = express.Router();

  // Every lot action (checkin/quality/weigh/jform/dispatch) is a
  // centre-side operation -- gated to the centre_officer/operator
  // assigned to that booking's centre, or any district_officer for that
  // centre's district. Mounted at '/:id' (not a bare `.use()`) so
  // `req.params.id` is actually populated by the time this middleware
  // runs -- a path-less `router.use()` runs before Express parses any
  // route's own `:id`, and req.params would be empty here otherwise.
  router.use('/:id', requireAuth, requireBookingCentreScope(pool));

  router.post(
    '/:id/checkin',
    (req, res, next) => {
      if (!isNonEmptyString(req.body && req.body.token)) {
        return res.status(400).json({ status: 'BAD_REQUEST', message: 'token is required' });
      }
      next();
    },
    lotAction(pool, checkinLot, 200)
  );

  router.post(
    '/:id/quality',
    (req, res, next) => {
      const body = req.body || {};
      const errors = [];
      if (!isNonEmptyString(body.meterId)) errors.push('meterId is required');
      if (!isNonEmptyString(body.calibrationDate)) errors.push('calibrationDate is required');
      if (!Array.isArray(body.samples) || body.samples.length !== 3 || body.samples.some((s) => typeof s !== 'number')) {
        errors.push('samples must be an array of exactly 3 numbers');
      }
      if (errors.length > 0) return res.status(400).json({ status: 'BAD_REQUEST', errors });
      next();
    },
    lotAction(pool, recordQuality, 201)
  );

  router.post('/:id/weigh', lotAction(pool, recordWeighment, 201));

  router.post(
    '/:id/jform',
    (req, res, next) => {
      const body = req.body || {};
      if (typeof body.mspRate !== 'number' || body.mspRate <= 0) {
        return res.status(400).json({ status: 'BAD_REQUEST', message: 'mspRate must be a positive number' });
      }
      if (body.deductions !== undefined && !Array.isArray(body.deductions)) {
        return res.status(400).json({ status: 'BAD_REQUEST', message: 'deductions must be an array' });
      }
      next();
    },
    lotAction(pool, issueJForm, 201)
  );

  router.post(
    '/:id/dispatch',
    (req, res, next) => {
      if (!isNonEmptyString(req.body && req.body.vehicleNumber)) {
        return res.status(400).json({ status: 'BAD_REQUEST', message: 'vehicleNumber is required' });
      }
      next();
    },
    lotAction(pool, recordDispatch, 201)
  );

  return router;
}

module.exports = { createLotRoutes };
