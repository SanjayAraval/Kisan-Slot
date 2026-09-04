'use strict';

const { YIELD_QUINTALS_PER_ACRE, OVER_DECLARE_CAP_MULTIPLIER, MOISTURE_ACCEPT_MAX_PCT } = require('./constants');

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// node-postgres parses a DATE column into a Date built from LOCAL-time
// components (year/month/day), not UTC ones -- toISOString() on it then
// shifts to the previous day in any timezone ahead of UTC (IST included).
// getFullYear/getMonth/getDate read back the same local components pg
// used to build it, so this always agrees with what's actually stored.
function toDateString(value) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Never send a full account number to the client -- last 4 digits is
// enough for a farmer to recognise their own account on screen.
function last4(value) {
  if (!value) return null;
  const digits = String(value);
  return digits.length <= 4 ? digits : digits.slice(-4);
}

// Minimal roster for the demo "pick a farmer" dropdown that stands in for
// OTP login -- name + phone is enough to tell farmers apart without
// exposing anything else in a list view.
async function listFarmers(pool) {
  const result = await pool.query('SELECT id, farmer_name, phone FROM farmers ORDER BY farmer_name');
  return result.rows.map((r) => ({ id: r.id, name: r.farmer_name, phone: r.phone }));
}

// Everything the IDENTIFY step needs: who they are, their pre-seeded land
// record (if any), and whether they need an officer callback instead of
// self-service booking. A tenant is routed to review here even though
// attemptBooking itself doesn't block tenants on that basis (it books
// against the linked owner's land record just fine) -- self-service under
// someone else's land record needs a human to confirm identity first;
// that's a screen-level gate, not a change to the booking rules.
async function loadFarmerDetail(pool, farmerId) {
  const result = await pool.query(
    `SELECT f.id, f.farmer_name, f.phone, f.is_tenant, f.bank_account_number,
            lr.village, lr.survey_number, lr.extent_acres
     FROM farmers f
     LEFT JOIN land_records lr ON lr.id = f.land_record_id
     WHERE f.id = $1`,
    [farmerId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const hasLandRecord = row.survey_number !== null;
  const extentAcres = hasLandRecord ? Number(row.extent_acres) : null;
  const landEstimateQuintals = hasLandRecord ? round(extentAcres * YIELD_QUINTALS_PER_ACRE, 2) : null;
  // Same cap attemptBooking enforces (OVER_DECLARE_CAP_MULTIPLIER x the
  // land-record estimate) -- shown up front so a farmer isn't surprised
  // by an officer-review flag after already picking a centre and date.
  const permittedQuantityQuintals = hasLandRecord ? round(landEstimateQuintals * OVER_DECLARE_CAP_MULTIPLIER, 2) : null;

  return {
    id: row.id,
    name: row.farmer_name,
    phone: row.phone,
    isTenant: row.is_tenant,
    hasLandRecord,
    needsOfficerReview: !hasLandRecord || row.is_tenant,
    village: row.village,
    surveyNumber: row.survey_number,
    extentAcres,
    landEstimateQuintals,
    permittedQuantityQuintals,
    bankAccountLast4: last4(row.bank_account_number),
  };
}

async function loadLatestBooking(pool, farmerId) {
  const result = await pool.query(
    `SELECT b.id, b.token, b.status, b.declared_quantity_quintals, b.bags_reserved,
            b.booked_at, b.checked_in_at, b.completed_at,
            cd.service_date, c.id AS centre_id, c.name AS centre_name, c.code AS centre_code
     FROM bookings b
     JOIN centre_day cd ON cd.id = b.centre_day_id
     JOIN centres c ON c.id = cd.centre_id
     WHERE b.farmer_id = $1
     ORDER BY b.booked_at DESC
     LIMIT 1`,
    [farmerId]
  );
  return result.rows[0] || null;
}

const STAGE_LABELS = {
  gate_entry: 'Gate entry',
  moisture_test: 'Moisture test',
  weighment: 'Weighment',
  acknowledgement: 'Acknowledgement',
  bill_raised: 'Bill raised',
  payment: 'Payment',
};

// The STATUS step's six-stage timeline for a farmer's most recent
// booking, plus the moisture and weighment detail to go with it. Every
// timestamp is read straight from the lot workflow (lot_quality_checks,
// lot_weighments, j_forms) -- nothing here is inferred or re-derived.
// Two stages have no dedicated event in the schema: "acknowledgement" is
// shown at the booking's completed_at (set by the same recordWeighment
// call that produces the weighment, since there's no separate
// sign-off step recorded); "payment" (PFMS settlement) isn't tracked
// anywhere in this system yet, so it's always shown as not reached.
async function loadLotStatus(pool, farmerId) {
  const booking = await loadLatestBooking(pool, farmerId);
  if (!booking) return null;

  const [qualityResult, weighmentResult, jFormResult] = await Promise.all([
    pool.query(
      `SELECT meter_id, calibration_date, sample_1, sample_2, sample_3, mean_moisture, verdict, tested_at
       FROM lot_quality_checks WHERE booking_id = $1`,
      [booking.id]
    ),
    pool.query('SELECT mode, net_kg, weighed_at FROM lot_weighments WHERE booking_id = $1', [booking.id]),
    pool.query(
      "SELECT id, j_form_number, issued_at FROM j_forms WHERE booking_id = $1 AND status = 'active'",
      [booking.id]
    ),
  ]);

  const quality = qualityResult.rows[0] || null;
  const weighment = weighmentResult.rows[0] || null;
  const jForm = jFormResult.rows[0] || null;

  const stages = [
    { key: 'gate_entry', at: booking.checked_in_at || null },
    { key: 'moisture_test', at: quality ? quality.tested_at : null },
    { key: 'weighment', at: weighment ? weighment.weighed_at : null },
    { key: 'acknowledgement', at: booking.completed_at || null },
    { key: 'bill_raised', at: jForm ? jForm.issued_at : null },
    { key: 'payment', at: null },
  ].map((s) => ({ key: s.key, label: STAGE_LABELS[s.key], at: s.at, done: s.at !== null }));

  return {
    booking: {
      id: booking.id,
      token: booking.token,
      status: booking.status,
      centreId: booking.centre_id,
      centreName: booking.centre_name,
      centreCode: booking.centre_code,
      serviceDate: toDateString(booking.service_date),
      declaredQuantityQuintals: Number(booking.declared_quantity_quintals),
      bagsReserved: Number(booking.bags_reserved),
      bookedAt: booking.booked_at,
    },
    stages,
    moisture: quality && {
      meterId: quality.meter_id,
      calibrationDate: toDateString(quality.calibration_date),
      samples: [Number(quality.sample_1), Number(quality.sample_2), Number(quality.sample_3)],
      meanMoisture: Number(quality.mean_moisture),
      verdict: quality.verdict,
      limitPct: MOISTURE_ACCEPT_MAX_PCT,
      testedAt: quality.tested_at,
    },
    weighment: weighment && {
      mode: weighment.mode,
      netKg: Number(weighment.net_kg),
      weighedAt: weighment.weighed_at,
    },
  };
}

// The J-FORM step's view of a farmer's most recent booking. net payable
// and the effective per-quintal rate are always derived here from the
// stored gross_amount and itemised payment_deductions -- matching the
// schema comment on payment_deductions ("gross_amount - sum(amount) gives
// net payable") -- never persisted, since nothing on j_forms stores them.
async function loadJForm(pool, farmerId) {
  const booking = await loadLatestBooking(pool, farmerId);
  if (!booking) return null;

  const jFormResult = await pool.query(
    `SELECT id, j_form_number, quintals_procured, msp_rate, gross_amount, issued_at
     FROM j_forms WHERE booking_id = $1 AND status = 'active'`,
    [booking.id]
  );
  const jForm = jFormResult.rows[0];
  if (!jForm) return null;

  const deductionsResult = await pool.query(
    'SELECT deduction_type, amount, description FROM payment_deductions WHERE j_form_id = $1 ORDER BY created_at',
    [jForm.id]
  );

  const grossAmount = Number(jForm.gross_amount);
  const totalDeductions = round(deductionsResult.rows.reduce((sum, d) => sum + Number(d.amount), 0), 2);
  const netPayable = round(grossAmount - totalDeductions, 2);
  const quintalsProcured = Number(jForm.quintals_procured);
  const mspRate = Number(jForm.msp_rate);

  return {
    jFormNumber: jForm.j_form_number,
    issuedAt: jForm.issued_at,
    quintalsProcured,
    mspRate,
    grossAmount,
    deductions: deductionsResult.rows.map((d) => ({
      type: d.deduction_type,
      amount: Number(d.amount),
      description: d.description,
    })),
    totalDeductions,
    netPayable,
    effectiveRatePerQuintal: quintalsProcured > 0 ? round(netPayable / quintalsProcured, 2) : null,
  };
}

module.exports = {
  listFarmers,
  loadFarmerDetail,
  loadLotStatus,
  loadJForm,
};
