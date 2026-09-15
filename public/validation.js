'use strict';

// Shared field-validation rules for the Kisan Slot forms. Loaded two ways:
//   - as a plain <script> on the registration/booking/declaration pages
//     (attaches to window.KisanValidation)
//   - via require() from the Express routes, so the server enforces the
//     exact same rules instead of a parallel copy that can drift.
// Every function here is pure and synchronous -- no DOM, no fetch -- so it
// works unmodified in both places. See CLAUDE.md: fail at the field, not
// at submit.

(function (root) {
  const ABSOLUTE_QUANTITY_CAP_QUINTALS = 5000;
  const LAND_SIZE_MIN_ACRES = 0.1;
  const LAND_SIZE_REVIEW_MAX_ACRES = 100;
  const LAND_SIZE_MAX_ACRES = 1000;
  const BOOKING_MAX_DAYS_AHEAD = 7;

  function isBlank(v) {
    return v === undefined || v === null || String(v).trim() === '';
  }

  // ---------------------------------------------------------------------
  // Mobile: exactly 10 digits, first digit 6-9, after stripping a +91/91
  // country-code prefix, a single leading 0 (STD-style), and any spaces
  // or hyphens. Rejects a number made of one repeated digit.
  // ---------------------------------------------------------------------
  function normalizeMobile(raw) {
    let s = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
    if (s.startsWith('+91')) s = s.slice(3);
    else if (s.startsWith('91') && s.length === 12) s = s.slice(2);
    else if (s.startsWith('0') && s.length === 11) s = s.slice(1);
    return s;
  }

  function validateMobile(raw) {
    const digits = normalizeMobile(raw);
    if (!/^\d{10}$/.test(digits)) return 'Enter a valid 10-digit mobile number';
    if (!/^[6-9]/.test(digits)) return 'Mobile number must start with 6, 7, 8 or 9';
    if (/^(\d)\1{9}$/.test(digits)) return 'Mobile number cannot be all the same digit';
    return null;
  }

  // ---------------------------------------------------------------------
  // Aadhaar: 12 digits, first digit not 0 or 1, and must pass the
  // Verhoeff checksum (the same algorithm UIDAI uses for the real check
  // digit) -- catches transposed/mistyped digits a plain length check
  // would miss.
  // ---------------------------------------------------------------------
  const VERHOEFF_D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0],
  ];
  const VERHOEFF_P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
  ];

  function verhoeffChecksumValid(digitsStr) {
    let c = 0;
    const digits = digitsStr.split('').reverse().map(Number);
    for (let i = 0; i < digits.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
    }
    return c === 0;
  }

  function validateAadhaar(raw) {
    const digits = String(raw == null ? '' : raw).trim();
    if (!/^\d{12}$/.test(digits)) return 'Aadhaar must be exactly 12 digits';
    if (/^[01]/.test(digits)) return 'Aadhaar cannot start with 0 or 1';
    if (!verhoeffChecksumValid(digits)) return 'Aadhaar number is invalid (checksum failed)';
    return null;
  }

  // ---------------------------------------------------------------------
  // Name: 2-60 chars, letters/spaces/apostrophes/hyphens only. Rejects a
  // string with no vowels (catches keyboard-mash input) and 4+ identical
  // consecutive characters (catches "Aaaaarav" typos and filler text).
  // ---------------------------------------------------------------------
  function validateName(raw) {
    const name = String(raw == null ? '' : raw).trim();
    if (name.length < 2 || name.length > 60) return 'Name must be 2-60 characters';
    if (!/^[A-Za-z\s'-]+$/.test(name)) return "Name may only contain letters, spaces, apostrophes and hyphens";
    if (!/[aeiouAEIOU]/.test(name)) return 'Name must contain at least one vowel';
    if (/(.)\1{3,}/.test(name)) return 'Name cannot repeat the same character 4 or more times in a row';
    return null;
  }

  // ---------------------------------------------------------------------
  // Village / district: 2-50 chars, letters and spaces only.
  // ---------------------------------------------------------------------
  function validatePlaceName(raw, label) {
    const v = String(raw == null ? '' : raw).trim();
    const what = label || 'This field';
    if (v.length < 2 || v.length > 50) return `${what} must be 2-50 characters`;
    if (!/^[A-Za-z\s]+$/.test(v)) return `${what} may only contain letters and spaces`;
    return null;
  }

  // ---------------------------------------------------------------------
  // Khasra / Khatauni number: 3-30 chars, alphanumeric with / and -.
  // ---------------------------------------------------------------------
  function validateKhasra(raw) {
    const k = String(raw == null ? '' : raw).trim();
    if (k.length < 3 || k.length > 30) return 'Khasra number must be 3-30 characters';
    if (!/^[A-Za-z0-9/-]+$/.test(k)) return 'Khasra number may only contain letters, numbers, / and -';
    return null;
  }

  // ---------------------------------------------------------------------
  // Land size (acres): 0.1-100 acres passes outright; 100-1000 passes but
  // needs officer review; above 1000 (or below 0.1) is rejected outright.
  // ---------------------------------------------------------------------
  function validateLandSize(raw) {
    const n = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) {
      return { error: 'Enter land size in acres', needsReview: false };
    }
    if (n < LAND_SIZE_MIN_ACRES) return { error: `Land size must be at least ${LAND_SIZE_MIN_ACRES} acres`, needsReview: false };
    if (n > LAND_SIZE_MAX_ACRES) return { error: `Land size cannot exceed ${LAND_SIZE_MAX_ACRES} acres`, needsReview: false };
    if (n > LAND_SIZE_REVIEW_MAX_ACRES) return { error: null, needsReview: true };
    return { error: null, needsReview: false };
  }

  // ---------------------------------------------------------------------
  // Quantity (quintals): positive, an absolute cap of 5000q regardless of
  // land size, and (when a land-record cap is known) within that cap too
  // -- both must pass.
  // ---------------------------------------------------------------------
  function validateQuantity(raw, landCapQuintals) {
    const n = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) return 'Quantity must be a number';
    if (n <= 0) return 'Quantity must be a positive number';
    if (n > ABSOLUTE_QUANTITY_CAP_QUINTALS) return `Quantity cannot exceed ${ABSOLUTE_QUANTITY_CAP_QUINTALS} quintals`;
    if (landCapQuintals != null && n > landCapQuintals) {
      return `Quantity exceeds the permitted cap of ${landCapQuintals} quintals for this land record`;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Bank account: 9-18 digits.
  // ---------------------------------------------------------------------
  function validateBankAccount(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (!/^\d{9,18}$/.test(v)) return 'Bank account number must be 9-18 digits';
    return null;
  }

  // ---------------------------------------------------------------------
  // IFSC: 4 letters, a literal 0, then 6 alphanumeric -- uppercased
  // automatically before the check, so a lowercase entry isn't rejected
  // just for case.
  // ---------------------------------------------------------------------
  function validateIfsc(raw) {
    const v = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) {
      return { error: 'Enter a valid IFSC code (e.g. SBIN0001234)', value: v };
    }
    return { error: null, value: v };
  }

  // ---------------------------------------------------------------------
  // Booking date: not in the past, not more than 7 days ahead. Dates are
  // plain YYYY-MM-DD strings throughout this app (see app.js), so string
  // comparison is safe and avoids timezone drift.
  // ---------------------------------------------------------------------
  function addDaysToDateString(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function validateBookingDate(dateStr, todayStr) {
    if (isBlank(dateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'date is required as YYYY-MM-DD';
    if (dateStr < todayStr) return 'date cannot be in the past';
    if (dateStr > addDaysToDateString(todayStr, BOOKING_MAX_DAYS_AHEAD)) {
      return `date cannot be more than ${BOOKING_MAX_DAYS_AHEAD} days ahead`;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // A positive integer within plausible operational bounds -- used for
  // the declaration screen's bags/gangs/trucks counts, none of which can
  // meaningfully be zero, negative or fractional.
  // ---------------------------------------------------------------------
  function validatePositiveIntegerInBounds(raw, { min = 1, max, label }) {
    const what = label || 'This field';
    const n = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) return `${what} must be a whole number`;
    if (!Number.isInteger(n)) return `${what} must be a whole number`;
    if (n < min) return `${what} must be at least ${min}`;
    if (max != null && n > max) return `${what} cannot exceed ${max}`;
    return null;
  }

  const KisanValidation = {
    ABSOLUTE_QUANTITY_CAP_QUINTALS,
    LAND_SIZE_MIN_ACRES,
    LAND_SIZE_REVIEW_MAX_ACRES,
    LAND_SIZE_MAX_ACRES,
    BOOKING_MAX_DAYS_AHEAD,
    normalizeMobile,
    validateMobile,
    validateAadhaar,
    validateName,
    validatePlaceName,
    validateKhasra,
    validateLandSize,
    validateQuantity,
    validateBankAccount,
    validateIfsc,
    addDaysToDateString,
    validateBookingDate,
    validatePositiveIntegerInBounds,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KisanValidation;
  } else {
    root.KisanValidation = KisanValidation;
  }
})(typeof window !== 'undefined' ? window : globalThis);
