'use strict';

const express = require('express');
const { runNightlyReallocation } = require('./reallocationJob');
const { enrichReallocationPlan, loadRecentMessages } = require('./adminService');
const { requireAuth, requireRole } = require('./authMiddleware');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function createAdminRoutes(pool) {
  const router = express.Router();

  // On-demand run of the nightly job -- normally cron-triggered (see
  // reallocationCli.js) and never otherwise visible, which made it
  // impossible to demonstrate. `date` plays the role of "today" in
  // runNightlyReallocation: today's no-shows are released, and D+1..D+7
  // are recomputed and, if now over capacity, reallocated. District-
  // officer only, matching every other district-wide action (dashboard,
  // release-bags) -- a centre officer runs their own centre, not the
  // reallocation that spans all of them.
  router.post('/admin/run-reallocation', requireAuth, requireRole('district_officer'), async (req, res, next) => {
    const { date } = req.body || {};
    if (!isNonEmptyString(date) || !DATE_RE.test(date)) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors: ['date is required as YYYY-MM-DD'] });
    }
    try {
      const plan = await runNightlyReallocation(pool, { today: date });
      const enriched = await enrichReallocationPlan(pool, plan, date);
      return res.status(200).json({ status: 'OK', ...enriched });
    } catch (err) {
      return next(err);
    }
  });

  // Recent queued notifications (SMS/IVR/app) -- the reallocation run's
  // own deferral notices plus anything else the mock gateway has queued
  // (OTP codes, etc.), so "queued" is actually visible somewhere instead
  // of only ever existing as rows nobody looks at.
  router.get('/admin/messages', requireAuth, requireRole('district_officer'), async (req, res, next) => {
    try {
      const messages = await loadRecentMessages(pool, req.user.district);
      return res.status(200).json({ messages });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createAdminRoutes };
