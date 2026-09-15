'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = __dirname;
const IGNORE_DIRS = new Set(['testUtils']);
const SELF = path.basename(__filename);

function listJsFiles(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === SELF) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out = out.concat(listJsFiles(full));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

// Extracts every literal SELECT/INSERT/UPDATE/DELETE passed to `.query(...)`
// as a plain string or backtick template -- this codebase never builds a
// table/column name by string concatenation, so a static regex over the
// source is enough to find every query shape the app can actually run.
// Deliberately skips anything that isn't a literal (e.g.
// `client.query(result.type === 'OK' ? 'COMMIT' : 'ROLLBACK')`) -- those
// never reference a column.
function extractQueries(source, absPath) {
  const queries = [];
  const re = /\.query\(\s*(`([\s\S]*?)`|'([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = re.exec(source))) {
    const sql = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (sql && /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql.trim())) {
      const line = source.slice(0, m.index).split('\n').length;
      queries.push({ file: path.relative(SRC_DIR, absPath).replace(/\\/g, '/'), line, sql: sql.trim() });
    }
  }
  return queries;
}

// Every static SQL query literal in src/ (excluding tests and this file
// itself), used both by checkSchema's default and by its own tests.
function collectQueries() {
  let all = [];
  for (const f of listJsFiles(SRC_DIR)) {
    all = all.concat(extractQueries(fs.readFileSync(f, 'utf8'), f));
  }
  return all;
}

// pg-mem (the test suite's in-memory Postgres) reports a missing UPDATE
// target column as `Column "x" not found` rather than real Postgres's
// `column "x" ... does not exist` -- match both so this behaves the same
// in tests and in production.
const SCHEMA_ERROR_RE = /does not exist|column ".*" not found/i;

// Validates every static SQL literal in src/ against the database this
// pool is connected to. Each query is actually run -- not just parsed --
// inside a transaction that is always rolled back, so a genuine "does
// this table/column exist" check works even for INSERT/UPDATE/DELETE
// without ever persisting anything or requiring EXPLAIN support (pg-mem,
// used by the test suite, doesn't implement EXPLAIN at all).
//
// Throws one Error listing every mismatch if the database is missing a
// table/column the code expects, so a deploy with a pending migration
// fails loudly at boot instead of as a 500 the first time some farmer or
// officer happens to hit that one endpoint.
async function checkSchema(pool, queries = collectQueries()) {
  const problems = [];

  for (const q of queries) {
    const placeholders = new Set((q.sql.match(/\$(\d+)/g) || []).map((p) => Number(p.slice(1))));
    const maxParam = placeholders.size ? Math.max(...placeholders) : 0;
    const params = Array(maxParam).fill(null);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(q.sql, params);
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (SCHEMA_ERROR_RE.test(err.message)) {
        problems.push(`  ${q.file}:${q.line} -- ${err.message.split('\n')[0]}\n    ${q.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      // Any other failure (a NOT NULL/CHECK/FK violation from the
      // null-filled params, an ambiguous parameter type, etc.) isn't a
      // schema problem -- the query parsed and referenced real
      // tables/columns, which is all this check cares about.
    } finally {
      client.release();
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Schema check failed: the database is missing ${problems.length} table/column the code expects to query.\n` +
        `Run any pending migrations in db/migrations/ before starting the server.\n\n` +
        problems.join('\n\n')
    );
  }
}

module.exports = { checkSchema, collectQueries };
