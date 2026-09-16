'use strict';

const crypto = require('crypto');
const { hashPassword } = require('../../src/authService');

// Demo credentials for the login screen's "Demo login" row and for anyone
// typing credentials by hand while judging. Never real accounts -- fine
// to keep the plaintext password here for a seed script.
const DEMO_PASSWORD = 'demo1234';

// One of each role, tied to the first seeded centre so `district_officer`
// (Medak, matching every seeded centre's district) and `centre_officer`/
// `operator` (that one centre) all have real, working scope.
async function buildEmployees(centres) {
  const centre = centres[0];
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  return [
    {
      id: crypto.randomUUID(),
      employeeId: 'DO-001',
      name: 'Anitha Reddy',
      role: 'district_officer',
      centreId: null,
      district: 'Medak',
      passwordHash,
    },
    {
      id: crypto.randomUUID(),
      employeeId: 'CO-001',
      name: 'Ravi Shankar',
      role: 'centre_officer',
      centreId: centre.id,
      district: null,
      passwordHash,
    },
    {
      id: crypto.randomUUID(),
      employeeId: 'OP-001',
      name: 'Lakshmi (CSC Operator)',
      role: 'operator',
      centreId: centre.id,
      district: null,
      passwordHash,
    },
  ];
}

module.exports = { buildEmployees, DEMO_PASSWORD };
