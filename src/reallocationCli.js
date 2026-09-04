'use strict';

require('dotenv').config();

const { createPool } = require('./db');
const { runNightlyReallocation } = require('./reallocationJob');

const args = process.argv.slice(2);
const todayArg = args.find((a) => a.startsWith('--today='));
const today = todayArg ? todayArg.split('=')[1] : undefined;

async function main() {
  const pool = createPool();
  try {
    const plan = await runNightlyReallocation(pool, { today });
    console.log(`Nightly reallocation for ${today || 'today'}:`);
    console.log(`  centre-days recomputed: ${plan.centreDayUpserts.length}`);
    console.log(`  no-shows released: ${plan.noShowReleases.length}`);
    console.log(`  deferrals: ${plan.deferrals.length}`);
    console.log(`  EWMA updates: ${plan.ewmaUpdates.length}`);
    console.log(`  notifications queued: ${plan.notifications.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Nightly reallocation failed:', err.message || err);
  process.exitCode = 1;
});
