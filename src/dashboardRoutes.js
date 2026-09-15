'use strict';

const express = require('express');
const { loadDistrictDashboard, releaseBags } = require('./dashboardService');
const { requireAuth, requireRole, requireCentreScope } = require('./authMiddleware');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function createDashboardRoutes(pool) {
  const router = express.Router();

  // District-wide view -- district_officer only, and scoped to their own
  // district (never the whole state).
  router.get('/dashboard', requireAuth, requireRole('district_officer'), async (req, res, next) => {
    const { date } = req.query;
    if (!isNonEmptyString(date) || !DATE_RE.test(date)) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors: ['date query param is required as YYYY-MM-DD'] });
    }
    try {
      const dashboard = await loadDistrictDashboard(pool, date, req.user.district);
      return res.status(200).json(dashboard);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/dashboard/centres/:id/release-bags', requireAuth, requireCentreScope(pool, (req) => req.params.id), async (req, res, next) => {
    const body = req.body || {};
    const errors = [];
    if (!isNonEmptyString(body.date) || !DATE_RE.test(body.date)) errors.push('date is required as YYYY-MM-DD');
    if (!isPositiveNumber(body.additionalBags)) errors.push('additionalBags must be a positive number');
    if (errors.length > 0) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors });
    }

    const centreId = req.params.id;
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await releaseBags(client, centreId, body.date, body.additionalBags);
      await client.query(result.type === 'OK' ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return next(err);
    }
    client.release();

    if (result.type !== 'OK') {
      const httpStatus = result.type === 'NOT_FOUND' ? 404 : 500;
      return res.status(httpStatus).json({ status: result.type, message: result.message });
    }
    const { type, ...responseBody } = result;
    return res.status(200).json({ status: 'OK', ...responseBody });
  });

  return router;
}

module.exports = { createDashboardRoutes };
