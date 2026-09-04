'use strict';

const { Pool } = require('pg');

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  return connectionString ? new Pool({ connectionString }) : new Pool();
}

module.exports = { createPool };
