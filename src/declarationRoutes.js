'use strict';

const express = require('express');
const { toApiInputs, computeCentreDayCapacity, upsertCentreDay, upsertDailyInputs } = require('./capacityService');
const { RECOMMENDED_ACTIONS } = require('./constants');
const { requireAuth, requireCentreScope } = require('./authMiddleware');
const { validatePositiveIntegerInBounds } = require('../public/validation');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Plausible day-to-day operational ceilings for a single procurement
// centre -- generous enough for any real centre, tight enough to catch a
// stray extra zero (e.g. 60000 gangs) before it reaches the capacity
// engine or the DB.
const GUNNY_BAGS_MAX = 200000;
const HAMALI_GANG_MAX = 500;
const TRUCK_EVACUATION_MAX = 2000;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isNonNegativeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Same shape the DB's own CHECK enforces: weighbridge mode needs a cycle
// time; platform mode needs seconds/bag and bags/lot. Validated here too
// so a bad declaration comes back as 400, not a DB constraint violation.
function validateDeclarationBody(body) {
  const errors = [];
  if (!isNonEmptyString(body.date) || !DATE_RE.test(body.date)) errors.push('date is required as YYYY-MM-DD');
  if (body.weighingMode !== 'weighbridge' && body.weighingMode !== 'platform') {
    errors.push("weighingMode must be 'weighbridge' or 'platform'");
  }
  if (!isPositiveNumber(body.weighbridgeOperatingMinutes)) errors.push('weighbridgeOperatingMinutes must be a positive number');
  if (!isPositiveNumber(body.bagsPerTruck)) errors.push('bagsPerTruck must be a positive number');

  // Bags, gangs and trucks are physical counts -- never zero, negative or
  // fractional, and bounded to something a real centre could plausibly
  // have on hand in a day.
  const gangErr = validatePositiveIntegerInBounds(body.hamaliGangCount, { max: HAMALI_GANG_MAX, label: 'hamaliGangCount' });
  if (gangErr) errors.push(gangErr);
  if (!isNonNegativeNumber(body.hamaliBagsPerGangPerDay)) errors.push('hamaliBagsPerGangPerDay must be a non-negative number');
  const gunnyErr = validatePositiveIntegerInBounds(body.gunnyBagsAvailable, { max: GUNNY_BAGS_MAX, label: 'gunnyBagsAvailable' });
  if (gunnyErr) errors.push(gunnyErr);
  const truckErr = validatePositiveIntegerInBounds(body.truckEvacuationCapacity, { max: TRUCK_EVACUATION_MAX, label: 'truckEvacuationCapacity' });
  if (truckErr) errors.push(truckErr);
  if (!isPositiveNumber(body.yardCapacityTonnes)) errors.push('yardCapacityTonnes must be a positive number');
  if (!isNonNegativeNumber(body.undispatchedTonnes)) errors.push('undispatchedTonnes must be a non-negative number');
  if (!isPositiveNumber(body.avgTruckLoadTonnes)) errors.push('avgTruckLoadTonnes must be a positive number');
  if (!isNonNegativeNumber(body.moistureMeterCount)) errors.push('moistureMeterCount must be a non-negative number');
  if (!isNonNegativeNumber(body.moistureTestsPerMeterPerDay)) errors.push('moistureTestsPerMeterPerDay must be a non-negative number');

  if (body.weighingMode === 'weighbridge' && !isPositiveNumber(body.weighbridgeAvgCycleMinutes)) {
    errors.push('weighbridgeAvgCycleMinutes must be a positive number in weighbridge mode');
  }
  if (body.weighingMode === 'platform') {
    if (!isPositiveNumber(body.secondsPerBag)) errors.push('secondsPerBag must be a positive number in platform mode');
    if (!isPositiveNumber(body.avgBagsPerLot)) errors.push('avgBagsPerLot must be a positive number in platform mode');
  }
  return errors;
}

function createDeclarationRoutes(pool) {
  const router = express.Router();

  router.get('/centres', async (req, res, next) => {
    try {
      const result = await pool.query('SELECT id, name, code, centre_type, latitude, longitude FROM centres ORDER BY name');
      return res.status(200).json(
        result.rows.map((r) => ({
          id: r.id,
          name: r.name,
          code: r.code,
          centreType: r.centre_type,
          // Real, already-stored coordinates -- not derived or guessed --
          // so the farmer screen can ask a weather API about this exact
          // centre instead of a hardcoded or district-average location.
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
        }))
      );
    } catch (err) {
      return next(err);
    }
  });

  const centreScope = requireCentreScope(pool, (req) => req.params.id);

  router.get('/centres/:id/declaration', requireAuth, centreScope, async (req, res, next) => {
    const { date } = req.query;
    if (!isNonEmptyString(date) || !DATE_RE.test(date)) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors: ['date query param is required as YYYY-MM-DD'] });
    }
    try {
      const result = await pool.query(
        'SELECT * FROM centre_daily_inputs WHERE centre_id = $1 AND service_date = $2',
        [req.params.id, date]
      );
      if (!result.rows[0]) {
        return res.status(404).json({ status: 'NOT_FOUND', message: 'no declaration on file for this centre and date' });
      }
      return res.status(200).json({ centreId: req.params.id, date, inputs: toApiInputs(result.rows[0]) });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/centres/:id/declaration', requireAuth, centreScope, async (req, res, next) => {
    const body = req.body || {};
    const errors = validateDeclarationBody(body);
    if (errors.length > 0) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors });
    }

    const centreId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const centre = await client.query('SELECT id FROM centres WHERE id = $1', [centreId]);
      if (!centre.rows[0]) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ status: 'NOT_FOUND', message: 'centre not found' });
      }

      await upsertDailyInputs(client, centreId, body.date, body);

      let capacity;
      try {
        capacity = await computeCentreDayCapacity(client, centreId, body.date);
      } catch (engineErr) {
        // computeDailyCapacity's own validation (TypeError/RangeError) --
        // the declaration was saved as syntactically valid rows but the
        // combination doesn't compute (shouldn't happen given the checks
        // above, but the engine is the final authority).
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ status: 'BAD_REQUEST', errors: [engineErr.message] });
      }

      await upsertCentreDay(client, centreId, body.date, capacity);
      await client.query('COMMIT');
      client.release();

      return res.status(200).json({
        centreId,
        date: body.date,
        totalCapacity: capacity.engineResult.totalCapacity,
        bookableCapacity: capacity.engineResult.bookableCapacity,
        walkInReserved: capacity.engineResult.walkInReserved,
        bindingConstraint: capacity.engineResult.bindingConstraint,
        bindingConstraints: capacity.engineResult.bindingConstraints,
        constraints: capacity.engineResult.constraints,
        recommendedAction: RECOMMENDED_ACTIONS[capacity.engineResult.bindingConstraint] || null,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return next(err);
    }
  });

  return router;
}

module.exports = { createDeclarationRoutes };
