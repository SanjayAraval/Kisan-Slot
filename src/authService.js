'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

// Falls back to a fixed dev secret so the app runs out of the box for a
// demo/judge without env setup -- set JWT_SECRET in production. In
// production that fallback would sign tokens anyone can forge, so boot
// fails loudly instead.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'kisan-slot-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '12h';
const OTP_TTL_MINUTES = 5;
const SCRYPT_KEYLEN = 64;
const scrypt = promisify(crypto.scrypt);

// Dev mode gates the OTP-echoed-in-response mock and the demo-login
// shortcut. Defaults to dev (undefined NODE_ENV) since this project has
// no production deployment configured -- set NODE_ENV=production to turn
// both off.
function isDevMode() {
  return process.env.NODE_ENV !== 'production';
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)).toString('hex');
  return `${salt}:${derived}`;
}

async function verifyPassword(password, stored) {
  const [salt, derivedHex] = String(stored || '').split(':');
  if (!salt || !derivedHex) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(derivedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// 6-digit, zero-padded -- crypto.randomInt is rejection-sampled (uniform,
// no modulo bias), unlike Math.random().
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function otpExpiresAt() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

const COOKIE_NAME = 'token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 12 * 60 * 60 * 1000,
  // No `secure: true` -- this demo runs over plain HTTP; a production
  // deploy behind HTTPS should add it.
};

// A short-lived, separate cookie asserting "this mobile number just
// passed OTP verification for registration" -- distinct from the session
// cookie above, since registration isn't a login (no farmer exists yet).
// POST /api/farmers/register trusts this instead of taking mobile+code
// again, so registration can't be spoofed without actually verifying.
const REG_COOKIE_NAME = 'regToken';
const REG_COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', maxAge: 15 * 60 * 1000 };

function signRegistrationToken(mobile) {
  return jwt.sign({ purpose: 'registration', mobile }, JWT_SECRET, { expiresIn: '15m' });
}

// Returns the verified mobile number, or null if the cookie is missing,
// expired, or doesn't carry the registration purpose.
function readRegistrationToken(req) {
  const token = req.cookies && req.cookies[REG_COOKIE_NAME];
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded || decoded.purpose !== 'registration' || !decoded.mobile) return null;
  return decoded.mobile;
}

module.exports = {
  isDevMode,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateOtp,
  otpExpiresAt,
  COOKIE_NAME,
  COOKIE_OPTIONS,
  REG_COOKIE_NAME,
  REG_COOKIE_OPTIONS,
  signRegistrationToken,
  readRegistrationToken,
};
