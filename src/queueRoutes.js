'use strict';

const express = require('express');
const { loadQueue } = require('./queueService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function createQueueRoutes(pool) {
  const router = express.Router();

  // Public, like /centres and /centres/:id/availability -- the whole
  // point is a farmer's own phone and an unauthenticated gate board can
  // both read it live, not just a logged-in officer.
  router.get('/centres/:id/queue', async (req, res, next) => {
    const { date } = req.query;
    if (!isNonEmptyString(date) || !DATE_RE.test(date)) {
      return res.status(400).json({ status: 'BAD_REQUEST', errors: ['date query param is required as YYYY-MM-DD'] });
    }
    try {
      const queue = await loadQueue(pool, req.params.id, date);
      if (!queue) return res.status(404).json({ status: 'NOT_FOUND', message: 'centre not found' });
      return res.status(200).json(queue);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createQueueRoutes };
