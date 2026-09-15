'use strict';

const { checkSchema, collectQueries } = require('./schemaCheck');
const { createTestPool } = require('./testUtils/pgMemDb');

describe('collectQueries', () => {
  test('finds real query literals across src/, including the one the name_hi/name_te bug came from', () => {
    const queries = collectQueries();
    expect(queries.length).toBeGreaterThan(50);

    const centresQuery = queries.find((q) => q.file === 'declarationRoutes.js' && /FROM centres/i.test(q.sql));
    expect(centresQuery).toBeDefined();
    expect(centresQuery.sql).toMatch(/name_hi/);
  });

  test('never captures its own file or test files', () => {
    const queries = collectQueries();
    expect(queries.some((q) => q.file === 'schemaCheck.js')).toBe(false);
    expect(queries.some((q) => q.file.endsWith('.test.js'))).toBe(false);
  });
});

describe('checkSchema', () => {
  test('passes against a freshly migrated database -- every query in src/ matches the current schema', async () => {
    const pool = createTestPool();
    await expect(checkSchema(pool)).resolves.toBeUndefined();
  });

  test('throws a clear error when a SELECT expects a column the database does not have', async () => {
    const pool = createTestPool();
    await expect(
      checkSchema(pool, [{ file: 'fake.js', line: 1, sql: 'SELECT name_xx FROM centres' }])
    ).rejects.toThrow(/name_xx.*does not exist/i);
  });

  test('throws a clear error when an UPDATE targets a column the database does not have', async () => {
    const pool = createTestPool();
    await expect(
      checkSchema(pool, [{ file: 'fake.js', line: 1, sql: 'UPDATE centres SET name_xx = $1 WHERE id = $2' }])
    ).rejects.toThrow(/name_xx/i);
  });

  test('throws a clear error when the code queries a table that does not exist', async () => {
    const pool = createTestPool();
    await expect(
      checkSchema(pool, [{ file: 'fake.js', line: 1, sql: 'SELECT id FROM not_a_real_table' }])
    ).rejects.toThrow(/not_a_real_table.*does not exist/i);
  });

  test('does not flag a valid query against a real table/column', async () => {
    const pool = createTestPool();
    await expect(
      checkSchema(pool, [{ file: 'fake.js', line: 1, sql: 'SELECT id, name, name_hi, name_te FROM centres WHERE id = $1' }])
    ).resolves.toBeUndefined();
  });

  test('does not flag a constraint violation from the null-filled parameters -- only genuine schema mismatches', async () => {
    const pool = createTestPool();
    // farmers.phone is NOT NULL; a null param trips that, not a schema
    // problem, so this must NOT be reported.
    await expect(
      checkSchema(pool, [{
        file: 'fake.js',
        line: 1,
        sql: 'INSERT INTO farmers (id, farmer_name, phone, registered_channel) VALUES ($1, $2, $3, $4)',
      }])
    ).resolves.toBeUndefined();
  });

  test('rolls back cleanly -- an INSERT/UPDATE in the checked list leaves no trace', async () => {
    const pool = createTestPool();
    await checkSchema(pool, [{ file: 'fake.js', line: 1, sql: 'UPDATE centres SET name = $1 WHERE id = $2' }]);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM centres');
    expect(count.rows[0].n).toBe(0); // untouched fresh pool, nothing seeded
  });

  test('reports every mismatch, not just the first', async () => {
    const pool = createTestPool();
    await expect(
      checkSchema(pool, [
        { file: 'a.js', line: 1, sql: 'SELECT bogus_a FROM centres' },
        { file: 'b.js', line: 2, sql: 'SELECT bogus_b FROM farmers' },
      ])
    ).rejects.toThrow(/2 table\/column/);
  });
});
