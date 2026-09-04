'use strict';

const { Pool } = require('pg');

function createPool() {
  return new Pool();
}

module.exports = { createPool };
