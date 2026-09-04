'use strict';

const express = require('express');
const { listFarmers, loadFarmerDetail, loadLotStatus, loadJForm } = require('./farmerService');

function createFarmerRoutes(pool) {
  const router = express.Router();

  router.get('/farmers', async (req, res, next) => {
    try {
      const farmers = await listFarmers(pool);
      return res.status(200).json(farmers);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/farmers/:id', async (req, res, next) => {
    try {
      const farmer = await loadFarmerDetail(pool, req.params.id);
      if (!farmer) return res.status(404).json({ status: 'NOT_FOUND', message: 'farmer not found' });
      return res.status(200).json(farmer);
    } catch (err) {
      return next(err);
    }
  });

  // Combines "booking status" and "lot status" into one read -- the
  // STATUS screen needs both together (which centre/date, and how far
  // the lot has progressed) and there's no reason to make the client
  // round-trip twice for it.
  router.get('/farmers/:id/status', async (req, res, next) => {
    try {
      const status = await loadLotStatus(pool, req.params.id);
      if (!status) return res.status(404).json({ status: 'NOT_FOUND', message: 'no bookings on file for this farmer' });
      return res.status(200).json(status);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/farmers/:id/jform', async (req, res, next) => {
    try {
      const jForm = await loadJForm(pool, req.params.id);
      if (!jForm) return res.status(404).json({ status: 'NOT_FOUND', message: 'no J-Form issued yet for this farmer' });
      return res.status(200).json(jForm);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createFarmerRoutes };
