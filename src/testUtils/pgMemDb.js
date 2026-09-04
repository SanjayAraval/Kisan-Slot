'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newDb } = require('pg-mem');

const MIGRATION_PATH = path.join(__dirname, '..', '..', 'db', 'migrations', '001_init_schema.sql');

// A fresh in-memory Postgres-compatible database with the real schema
// applied, for tests that need actual SQL (transactions, constraints,
// the atomic capacity-claim UPDATE) without a live Postgres server.
function createTestPool() {
  const db = newDb();
  db.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid',
      implementation: () => crypto.randomUUID(),
    });
  });

  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  db.public.none(sql);

  const { Pool } = db.adapters.createPg();
  return new Pool();
}

module.exports = { createTestPool };
