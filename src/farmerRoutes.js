'use strict';

const express = require('express');
const { listFarmers, loadFarmerDetail, loadLotStatus, loadJForm, lookupLandRecordByNumber, registerFarmer } = require('./farmerService');
const { getUser, requireAuth, requireRole, requireFarmerSelfOrOfficer } = require('./authMiddleware');
const { readRegistrationToken } = require('./authService');
const { idempotentReplay, recordIdempotentResponse } = require('./idempotency');
const {
  normalizeMobile,
  validateMobile,
  validateAadhaar,
  validateName,
  validateKhasra,
  validateLandSize,
  validateBankAccount,
  validateIfsc,
} = require('../public/validation');

function isProvided(v) {
  return v !== undefined && v !== null && v !== '';
}

function createFarmerRoutes(pool) {
  const router = express.Router();

  // Officer/operator roster lookup (assisted flows, review queues) --
  // never exposed to a farmer's own session, so one farmer can't
  // enumerate every other farmer.
  router.get('/farmers', requireAuth, requireRole('centre_officer', 'district_officer', 'operator'), async (req, res, next) => {
    try {
      const farmers = await listFarmers(pool);
      return res.status(200).json(farmers);
    } catch (err) {
      return next(err);
    }
  });

  // Public: the registration flow's live khasra lookup, called before any
  // account exists.
  router.get('/land-records/lookup', async (req, res, next) => {
    const number = String(req.query.number || '').trim().toUpperCase();
    if (!number) return res.status(400).json({ status: 'BAD_REQUEST', message: 'number query param is required' });
    try {
      const record = await lookupLandRecordByNumber(pool, number);
      if (!record) return res.status(404).json({ status: 'NOT_FOUND', message: 'no matching land record' });
      return res.status(200).json(record);
    } catch (err) {
      return next(err);
    }
  });

  // Public: self-service or assisted farmer registration. Reachable
  // before login by design -- an operator session (if present) is read
  // optionally, to stamp the audit field and pick the registered channel,
  // never to gate access.
  router.post('/farmers/register', async (req, res, next) => {
    const body = req.body || {};
    const errors = [];
    const nameErr = validateName(body.name);
    if (nameErr) errors.push(nameErr);

    const mobile = normalizeMobile(body.mobile);
    const mobileErr = validateMobile(body.mobile);
    if (mobileErr) errors.push(mobileErr);

    if (isProvided(body.aadhaar)) {
      const aadhaarErr = validateAadhaar(body.aadhaar);
      if (aadhaarErr) errors.push(aadhaarErr);
    }

    if (isProvided(body.khasra)) {
      const khasraErr = validateKhasra(body.khasra);
      if (khasraErr) errors.push(khasraErr);
    }

    let needsLandReview = false;
    if (isProvided(body.landSizeAcres)) {
      const { error: landErr, needsReview } = validateLandSize(body.landSizeAcres);
      if (landErr) errors.push(landErr);
      needsLandReview = needsReview;
    }

    if (isProvided(body.bankAccountNumber)) {
      const bankErr = validateBankAccount(body.bankAccountNumber);
      if (bankErr) errors.push(bankErr);
    }

    let bankIfsc = null;
    if (isProvided(body.bankIfsc)) {
      const { error: ifscErr, value: ifscValue } = validateIfsc(body.bankIfsc);
      if (ifscErr) errors.push(ifscErr);
      bankIfsc = ifscValue;
    }

    if (errors.length > 0) return res.status(400).json({ status: 'BAD_REQUEST', errors });

    const verifiedMobile = readRegistrationToken(req);
    if (verifiedMobile !== mobile) {
      return res.status(400).json({ status: 'BAD_REQUEST', message: 'mobile number was not OTP-verified -- request and verify a code first' });
    }

    // Placed after the OTP-verification check above, so replaying a
    // stale key still requires the same proof-of-phone the original
    // request needed -- see idempotency.js. Registration is the first
    // offline-queueable action a new farmer can hit (see
    // public/offline-queue.js): the OTP round trip needs a connection,
    // but the final submit -- often a long form -- can easily land after
    // signal drops.
    if (await idempotentReplay(pool, req, res)) return;
    recordIdempotentResponse(pool, req, res);

    const user = getUser(req);
    const operator = user && user.role === 'operator' ? { id: user.employeeDbId, name: user.name } : null;

    try {
      const result = await registerFarmer(
        pool,
        {
          name: body.name.trim(),
          mobile,
          aadhaar: body.aadhaar || null,
          khasra: body.khasra ? String(body.khasra).trim().toUpperCase() : null,
          landSizeAcres: typeof body.landSizeAcres === 'number' ? body.landSizeAcres : null,
          crop: body.crop || null,
          bankAccountNumber: body.bankAccountNumber || null,
          bankIfsc,
        },
        operator
      );
      if (result.type === 'CONFLICT') {
        return res.status(409).json({ status: 'CONFLICT', message: result.message });
      }
      return res.status(201).json({
        status: 'REGISTERED',
        farmerId: result.farmerId,
        verified: result.verified,
        needsOfficerReview: result.needsOfficerReview || needsLandReview,
        isTenant: result.isTenant,
        assistedByOperator: operator !== null,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/farmers/:id', requireAuth, requireFarmerSelfOrOfficer((req) => req.params.id), async (req, res, next) => {
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
  // round-trip twice for it. Returns every upcoming booking (a farmer can
  // hold more than one, on different dates -- see bookingService.
  // hasActiveBookingOnDate), not just the latest.
  router.get('/farmers/:id/status', requireAuth, requireFarmerSelfOrOfficer((req) => req.params.id), async (req, res, next) => {
    try {
      const bookings = await loadLotStatus(pool, req.params.id);
      if (!bookings) return res.status(404).json({ status: 'NOT_FOUND', message: 'no upcoming bookings on file for this farmer' });
      return res.status(200).json(bookings);
    } catch (err) {
      return next(err);
    }
  });

  // Every completed lot's bill, not just the latest.
  router.get('/farmers/:id/jform', requireAuth, requireFarmerSelfOrOfficer((req) => req.params.id), async (req, res, next) => {
    try {
      const jForms = await loadJForm(pool, req.params.id);
      if (!jForms) return res.status(404).json({ status: 'NOT_FOUND', message: 'no J-Form issued yet for this farmer' });
      return res.status(200).json(jForms);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createFarmerRoutes };
