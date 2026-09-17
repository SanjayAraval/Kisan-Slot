'use strict';

const crypto = require('crypto');
const { hashPassword } = require('../../src/authService');

// Demo credentials for the login screen's "Demo login" row and for anyone
// typing credentials by hand while judging. Never real accounts -- fine
// to keep the plaintext password here for a seed script.
const DEMO_PASSWORD = 'demo1234';

// One of each role, tied to the first seeded centre so `district_officer`
// (Medak, matching every seeded centre's district) and `centre_officer`/
// `operator` (that one centre) all have real, working scope. A second
// centre_officer is seeded at the second centre (Narsapur APMC Mandi) so
// there's more than one centre with a real officer to log in as -- this
// used to be inserted by hand after every reseed.
async function buildEmployees(centres) {
  const centre = centres[0];
  const secondCentre = centres[1];
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
      employeeId: 'CO-002',
      name: 'Suresh Kumar',
      role: 'centre_officer',
      centreId: secondCentre.id,
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
