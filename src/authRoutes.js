'use strict';

const crypto = require('crypto');
const express = require('express');
const {
  isDevMode,
  verifyPassword,
  signToken,
  generateOtp,
  otpExpiresAt,
  COOKIE_NAME,
  COOKIE_OPTIONS,
  REG_COOKIE_NAME,
  REG_COOKIE_OPTIONS,
  signRegistrationToken,
} = require('./authService');
const { getUser } = require('./authMiddleware');
const { normalizeMobile, validateMobile } = require('../public/validation');

const DEMO_EMPLOYEE_ROLES = ['centre_officer', 'district_officer', 'operator'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function createAuthRoutes(pool) {
  const router = express.Router();

  // Mock SMS gateway: generates and stores a code, never calls a real
  // provider. In dev mode the response echoes the code directly (devCode)
  // so the UI/judges never need an actual phone; in production that field
  // is omitted and the code only ever reaches the farmer via the (mocked)
  // messages table.
  router.post('/request-otp', async (req, res, next) => {
    const mobile = normalizeMobile((req.body || {}).mobile);
    const { purpose } = req.body || {};
    const mobileErr = validateMobile(mobile);
    if (mobileErr) {
      return res.status(400).json({ status: 'BAD_REQUEST', message: mobileErr });
    }
    if (purpose !== 'login' && purpose !== 'registration') {
      return res.status(400).json({ status: 'BAD_REQUEST', message: "purpose must be 'login' or 'registration'" });
    }

    try {
      const farmerResult = await pool.query('SELECT id, farmer_name FROM farmers WHERE phone = $1', [mobile]);
      const farmer = farmerResult.rows[0] || null;

      if (purpose === 'login' && !farmer) {
        return res.status(404).json({ status: 'NOT_FOUND', message: 'no account with this mobile number -- new farmer? register instead' });
      }
      if (purpose === 'registration' && farmer) {
        return res.status(409).json({ status: 'CONFLICT', message: 'this mobile number is already registered -- log in instead' });
      }

      const code = generateOtp();
      await pool.query(
        'INSERT INTO otp_codes (id, mobile, code, purpose, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [crypto.randomUUID(), mobile, code, purpose, otpExpiresAt()]
      );
      await pool.query(
        'INSERT INTO messages (id, farmer_id, mobile, channel, body, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          crypto.randomUUID(),
          farmer ? farmer.id : null,
          mobile,
          'sms',
          `Your Kisan Slot verification code is ${code}. It expires in 5 minutes.`,
          'sent',
        ]
      );

      const response = { status: 'OTP_SENT', mobile };
      if (isDevMode()) response.devCode = code;
      return res.status(200).json(response);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/verify-otp', async (req, res, next) => {
    const mobile = normalizeMobile((req.body || {}).mobile);
    const { code, purpose } = req.body || {};
    if (validateMobile(mobile) || !isNonEmptyString(code)) {
      return res.status(400).json({ status: 'BAD_REQUEST', message: 'mobile and code are required' });
    }
    if (purpose !== 'login' && purpose !== 'registration') {
      return res.status(400).json({ status: 'BAD_REQUEST', message: "purpose must be 'login' or 'registration'" });
    }

    try {
      const otpResult = await pool.query(
        `SELECT id FROM otp_codes
         WHERE mobile = $1 AND purpose = $2 AND code = $3 AND consumed_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [mobile, purpose, code]
      );
      const otpRow = otpResult.rows[0];
      if (!otpRow) {
        return res.status(400).json({ status: 'BAD_REQUEST', message: 'incorrect or expired code' });
      }
      // Single-use -- a replayed code fails the WHERE clause above on any
      // second attempt.
      await pool.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otpRow.id]);

      if (purpose === 'login') {
        const farmerResult = await pool.query('SELECT id, farmer_name FROM farmers WHERE phone = $1', [mobile]);
        const farmer = farmerResult.rows[0];
        if (!farmer) return res.status(404).json({ status: 'NOT_FOUND', message: 'no account with this mobile number' });

        const token = signToken({ role: 'farmer', farmerId: farmer.id, name: farmer.farmer_name });
        res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
        return res.status(200).json({ status: 'OK', role: 'farmer', farmerId: farmer.id, name: farmer.farmer_name });
      }

      // purpose === 'registration': confirms this mobile for the
      // following POST /api/farmers/register -- not a login session, since
      // no farmer exists yet.
      const regToken = signRegistrationToken(mobile);
      res.cookie(REG_COOKIE_NAME, regToken, REG_COOKIE_OPTIONS);
      return res.status(200).json({ status: 'OK', mobile });
    } catch (err) {
      return next(err);
    }
  });

  // Officers and assisted operators: employee ID + password, never email.
  router.post('/login', async (req, res, next) => {
    const { employeeId, password } = req.body || {};
    if (!isNonEmptyString(employeeId) || !isNonEmptyString(password)) {
      return res.status(400).json({ status: 'BAD_REQUEST', message: 'employeeId and password are required' });
    }

    try {
      const result = await pool.query(
        `SELECT id, password_hash, name, role, centre_id, district
         FROM employees WHERE employee_id = $1 AND status = 'active'`,
        [employeeId]
      );
      const emp = result.rows[0];
      // Same "invalid credentials" message either way -- never reveal
      // whether the employee ID itself exists.
      if (!emp || !verifyPassword(password, emp.password_hash)) {
        return res.status(401).json({ status: 'UNAUTHORIZED', message: 'invalid employee ID or password' });
      }

      const token = signToken({ role: emp.role, employeeDbId: emp.id, name: emp.name, centreId: emp.centre_id, district: emp.district });
      res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
      return res.status(200).json({ status: 'OK', role: emp.role, name: emp.name, centreId: emp.centre_id, district: emp.district });
    } catch (err) {
      return next(err);
    }
  });

  // One-click role logins for the login screen's "Demo login" row, so
  // judging a role never depends on typing (or knowing) real credentials.
  // Dev-mode only -- an unauthenticated shortcut into any role has no
  // place in a real deployment.
  router.post('/demo-login', async (req, res, next) => {
    if (!isDevMode()) return res.status(404).json({ status: 'NOT_FOUND' });
    const { role } = req.body || {};

    try {
      if (role === 'farmer') {
        const result = await pool.query(
          `SELECT id, farmer_name FROM farmers
           WHERE land_record_id IS NOT NULL AND is_tenant = false AND status = 'active'
           ORDER BY registered_at ASC LIMIT 1`
        );
        const farmer = result.rows[0];
        if (!farmer) return res.status(404).json({ status: 'NOT_FOUND', message: 'no demo farmer available -- seed the database first' });

        const token = signToken({ role: 'farmer', farmerId: farmer.id, name: farmer.farmer_name });
        res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
        return res.status(200).json({ status: 'OK', role: 'farmer', farmerId: farmer.id, name: farmer.farmer_name });
      }

      if (DEMO_EMPLOYEE_ROLES.includes(role)) {
        const result = await pool.query(
          `SELECT id, name, role, centre_id, district FROM employees
           WHERE role = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
          [role]
        );
        const emp = result.rows[0];
        if (!emp) return res.status(404).json({ status: 'NOT_FOUND', message: `no demo ${role} account available -- seed the database first` });

        const token = signToken({ role: emp.role, employeeDbId: emp.id, name: emp.name, centreId: emp.centre_id, district: emp.district });
        res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
        return res.status(200).json({ status: 'OK', role: emp.role, name: emp.name, centreId: emp.centre_id, district: emp.district });
      }

      return res.status(400).json({ status: 'BAD_REQUEST', message: 'role must be one of farmer, centre_officer, district_officer, operator' });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/me', (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ status: 'UNAUTHENTICATED', message: 'not logged in' });
    const { iat, exp, ...claims } = user; // eslint-disable-line no-unused-vars
    return res.status(200).json({ status: 'OK', ...claims });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    return res.status(200).json({ status: 'OK' });
  });

  return router;
}

module.exports = { createAuthRoutes };
