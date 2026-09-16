'use strict';

const express = require('express');
const { checkinLot, recordQuality, recordWeighment, issueJForm, recordDispatch } = require('./lotService');
const { scanLot, markServed, lookupByToken } = require('./queueService');
const { requireAuth, requireRole, requireBookingCentreScope } = require('./authMiddleware');
const queueEvents = require('./queueEvents');
const { todayInIST } = require('./todayInIST');
const { idempotentReplay, recordIdempotentResponse } = require('./idempotency');

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
// `onCommitted(result)`, when given, runs after a successful commit --
// scan/serve use it to broadcast the queue change (see queueEvents.js)
// only once the transaction has actually landed, never speculatively
// ahead of a possible rollback.
function lotAction(pool, fn, successStatus, onCommitted) {
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
      if (onCommitted) onCommitted(result);
      const { type, ...body } = result;
      return res.status(successStatus).json({ status: 'OK', ...body });
    }
    const httpStatus = STATUS_BY_RESULT_TYPE[result.type] || 500;
    return res.status(httpStatus).json({ status: result.type, message: result.message });
  };
}

// `now` is injectable so tests aren't at the mercy of the wall clock --
// mirrors the same override on createApp/runNightlyReallocation.
function createLotRoutes(pool, { now = todayInIST } = {}) {
  const router = express.Router();

  // Resolves a scanned/typed token to the booking it belongs to -- the
  // gate scan screen's manual-entry fallback only ever has the token, not
  // a booking id to address /:id/scan with. Registered *before* the
  // `/:id` middleware below: Express matches routes in registration
  // order, and that middleware's own `/:id` would otherwise swallow this
  // path too, treating the literal segment "by-token" as if it were a
  // booking id. Not centre-scoped -- there's no centre to scope by until
  // after this lookup -- but read-only and centre_officer/operator-only;
  // the follow-up POST .../scan is what actually enforces centre scope.
  router.get('/by-token/:token', requireAuth, requireRole('centre_officer', 'operator'), async (req, res, next) => {
    try {
      const booking = await lookupByToken(pool, req.params.token);
      if (!booking) return res.status(404).json({ status: 'NOT_FOUND', message: 'no booking with this token' });
      return res.status(200).json(booking);
    } catch (err) {
      return next(err);
    }
  });

  // Every lot action (checkin/quality/weigh/jform/dispatch/scan/serve) is
  // a centre-side operation -- gated to the centre_officer/operator
  // assigned to that booking's centre, or any district_officer for that
  // centre's district. Mounted at '/:id' (not a bare `.use()`) so
  // `req.params.id` is actually populated by the time this middleware
  // runs -- a path-less `router.use()` runs before Express parses any
  // route's own `:id`, and req.params would be empty here otherwise.
  router.use('/:id', requireAuth, requireBookingCentreScope(pool));

  // Placed after the shared '/:id' auth/centre-scope middleware above, so
  // replaying a stale key still requires the same centre-scoped
  // authorization the original request needed -- see idempotency.js.
  // Wired into scan/serve only: the two actions the gate queue's offline
  // outbox (see public/offline-queue.js and queue.html) actually
  // replays -- a retried scan must not re-check-in an already-checked-in
  // lot, and a retried serve must not call the same lot forward twice.
  function idempotent(req, res, next) {
    idempotentReplay(pool, req, res).then((replayed) => {
      if (replayed) return;
      recordIdempotentResponse(pool, req, res);
      next();
    }, next);
  }

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

  // The gate scan itself -- same token/status validation as checkin
  // above (scanLot calls it directly), broadcast to the centre's live
  // queue screens/board once committed.
  router.post(
    '/:id/scan',
    idempotent,
    (req, res, next) => {
      if (!isNonEmptyString(req.body && req.body.token)) {
        return res.status(400).json({ status: 'BAD_REQUEST', message: 'token is required' });
      }
      next();
    },
    lotAction(
      pool,
      (client, bookingId, body) => scanLot(client, bookingId, body.token, now()),
      200,
      (result) => queueEvents.emit('changed', result.centreId)
    )
  );

  // Advances the queue -- the officer calling the current now-serving
  // token forward. See queueService.markServed for why this never
  // touches bookings.status.
  router.post(
    '/:id/serve',
    idempotent,
    lotAction(
      pool,
      (client, bookingId) => markServed(client, bookingId),
      200,
      (result) => queueEvents.emit('changed', result.centreId)
    )
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
