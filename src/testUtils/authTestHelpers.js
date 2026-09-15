'use strict';

const request = require('supertest');
const cookiejar = require('cookiejar');
const { signToken, COOKIE_NAME } = require('../authService');

// Seeds a supertest agent's cookie jar directly with a signed session --
// no request round-trip through /api/auth needed. Lets existing
// business-logic tests (written before auth existed) keep using one
// consistent, broadly-privileged identity without knowing about login.
function agentAs(app, claims) {
  const agent = request.agent(app);
  const token = signToken(claims);
  agent.jar.setCookie(cookiejar.Cookie(`${COOKIE_NAME}=${token}; Path=/`));
  return agent;
}

function farmerAgent(app, farmerId, name = 'Test Farmer') {
  return agentAs(app, { role: 'farmer', farmerId, name });
}

// District 'Medak' matches testUtils/fixtures.js's insertCentre default --
// this one identity satisfies requireCentreScope/requireRole for any
// fixture-created centre without the test needing to know its id ahead of
// time.
function districtOfficerAgent(app, district = 'Medak', employeeDbId = 'test-district-officer') {
  return agentAs(app, { role: 'district_officer', district, employeeDbId, name: 'Test District Officer' });
}

function centreOfficerAgent(app, centreId, employeeDbId = 'test-centre-officer') {
  return agentAs(app, { role: 'centre_officer', centreId, employeeDbId, name: 'Test Centre Officer' });
}

function operatorAgent(app, centreId = 'test-centre', employeeDbId = 'test-operator') {
  return agentAs(app, { role: 'operator', centreId, employeeDbId, name: 'Test Operator' });
}

module.exports = { agentAs, farmerAgent, districtOfficerAgent, centreOfficerAgent, operatorAgent };
