'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newDb } = require('pg-mem');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

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

  // Every migration file, in filename order -- same order a real deploy
  // would apply them in.
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    db.public.none(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  const { Pool } = db.adapters.createPg();
  return new Pool();
}

module.exports = { createTestPool };
