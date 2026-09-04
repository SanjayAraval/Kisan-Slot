'use strict';

const { runNightlyReallocation } = require('./reallocationJob');
const { createTestPool } = require('./testUtils/pgMemDb');
const {
  insertCentre,
  insertDailyInputs,
  insertFarmerWithLand,
  insertCentreDay,
  insertBooking,
} = require('./testUtils/fixtures');

const TODAY = '2026-09-04';
const TOMORROW = '2026-09-05';

function setup() {
  return createTestPool();
}

describe('runNightlyReallocation', () => {
  test('a capacity drop defers the largest (least-smallholder-protected) bookings, and updates the ledger', async () => {
    const pool = setup();
    const centreId = await insertCentre(pool);

    // The day already has 6 confirmed bookings totalling 600 bags against
    // an existing 800-bag capacity.
    const centreDayId = await insertCentreDay(pool, {
      centreId,
      serviceDate: TOMORROW,
      bagsCapacity: 800,
      bagsBooked: 600,
    });

    const bookingIds = [];
    for (let i = 0; i < 6; i++) {
      // Farmers 0-1 are large holdings (least protected); 2-5 are small
      // (protected by smallholder priority). All else held equal.
      const extentAcres = i < 2 ? 10 : 1;
      const farmerId = await insertFarmerWithLand(pool, { extentAcres, farmerName: `Farmer ${i}` });
      const bookingId = await insertBooking(pool, {
        centreDayId,
        farmerId,
        bagsReserved: 100,
        declaredQuantityQuintals: extentAcres * 24, // exact match -> no deviation penalty
        status: 'booked',
        bookedAt: '2026-09-01T00:00:00Z',
      });
      bookingIds.push({ bookingId, farmerId, extentAcres });
    }

    // Tomorrow's operating data recomputes to a much smaller day: 4
    // trucks bookable * 100 bags/truck = 400 bags -- 200 short of the 600
    // already booked.
    await insertDailyInputs(pool, {
      centreId,
      serviceDate: TOMORROW,
      overrides: { truckEvacuationCapacity: 5 }, // -> total 5, walk-in reserve 1, bookable 4
    });

    const plan = await runNightlyReallocation(pool, { today: TODAY });

    expect(plan.deferrals).toHaveLength(2);

    const deferredBookings = await pool.query("SELECT id, farmer_id FROM bookings WHERE status = 'deferred'");
    expect(deferredBookings.rowCount).toBe(2);
    const deferredFarmerIds = deferredBookings.rows.map((r) => r.farmer_id).sort();
    const expectedLargeFarmers = bookingIds
      .filter((b) => b.extentAcres === 10)
      .map((b) => b.farmerId)
      .sort();
    expect(deferredFarmerIds).toEqual(expectedLargeFarmers);

    const remainingBooked = await pool.query("SELECT COUNT(*)::int AS n FROM bookings WHERE status = 'booked'");
    expect(remainingBooked.rows[0].n).toBe(4);

    const centreDay = await pool.query('SELECT bags_booked, bags_capacity FROM centre_day WHERE id = $1', [
      centreDayId,
    ]);
    expect(Number(centreDay.rows[0].bags_capacity)).toBe(400);
    expect(Number(centreDay.rows[0].bags_booked)).toBe(400); // 600 - 200 released

    const deferralRows = await pool.query('SELECT * FROM deferrals');
    expect(deferralRows.rowCount).toBe(2);

    const messageRows = await pool.query('SELECT * FROM messages');
    expect(messageRows.rowCount).toBe(2);
    expect(messageRows.rows[0].body).toMatch(/deferred/i);
  });

  test('distanceKm is computed from real land-record/centre coordinates, not hardcoded: the farther farmer is deferred first', async () => {
    const pool = setup();
    // Centre sits at (18.00, 78.00).
    const centreId = await insertCentre(pool, { lat: 18.0, lng: 78.0 });
    const centreDayId = await insertCentreDay(pool, {
      centreId,
      serviceDate: TOMORROW,
      bagsCapacity: 200,
      bagsBooked: 200,
    });

    // Identical in every other scoring factor -- extent, declared
    // quantity, bookedAt -- so only distance can explain the outcome.
    const nearFarmerId = await insertFarmerWithLand(pool, {
      extentAcres: 3,
      farmerName: 'Near Farmer',
      lat: 18.0, // effectively at the centre -- ~0km
      lng: 78.0,
    });
    const farFarmerId = await insertFarmerWithLand(pool, {
      extentAcres: 3,
      farmerName: 'Far Farmer',
      lat: 18.5, // ~56km north
      lng: 78.0,
    });

    for (const [farmerId] of [[nearFarmerId], [farFarmerId]]) {
      await insertBooking(pool, {
        centreDayId,
        farmerId,
        bagsReserved: 100,
        declaredQuantityQuintals: 3 * 24,
        status: 'booked',
        bookedAt: '2026-09-01T00:00:00Z',
      });
    }

    // Recompute keeps capacity at only 1 bookable truck (100 bags) --
    // one of the two 100-bag bookings must be deferred.
    await insertDailyInputs(pool, {
      centreId,
      serviceDate: TOMORROW,
      overrides: { truckEvacuationCapacity: 2 }, // total 2, walk-in 1, bookable 1 -> 100 bags
    });

    const plan = await runNightlyReallocation(pool, { today: TODAY });

    expect(plan.deferrals).toHaveLength(1);
    expect(plan.deferrals[0].farmerId).toBe(farFarmerId);

    const deferredBooking = await pool.query("SELECT farmer_id FROM bookings WHERE status = 'deferred'");
    expect(deferredBooking.rows[0].farmer_id).toBe(farFarmerId);
    const keptBooking = await pool.query("SELECT farmer_id FROM bookings WHERE status = 'booked'");
    expect(keptBooking.rows[0].farmer_id).toBe(nearFarmerId);
  });

  test('releases no-show capacity from today, and is idempotent across repeated runs', async () => {
    const pool = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, {
      centreId,
      serviceDate: TODAY,
      bagsCapacity: 800,
      bagsBooked: 300,
    });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 2 });
    const bookingId = await insertBooking(pool, {
      centreDayId,
      farmerId,
      bagsReserved: 100,
      status: 'no_show',
    });

    await runNightlyReallocation(pool, { today: TODAY });

    const afterFirstRun = await pool.query('SELECT bags_booked FROM centre_day WHERE id = $1', [centreDayId]);
    expect(Number(afterFirstRun.rows[0].bags_booked)).toBe(200); // 300 - 100

    const bookingAfter = await pool.query('SELECT capacity_released_at FROM bookings WHERE id = $1', [bookingId]);
    expect(bookingAfter.rows[0].capacity_released_at).not.toBeNull();

    // Running again must not release the same booking's bags twice.
    await runNightlyReallocation(pool, { today: TODAY });
    const afterSecondRun = await pool.query('SELECT bags_booked FROM centre_day WHERE id = $1', [centreDayId]);
    expect(Number(afterSecondRun.rows[0].bags_booked)).toBe(200);
  });

  test('updates a centres service-time EWMA from todays completed lots', async () => {
    const pool = setup();
    const centreId = await insertCentre(pool);
    const centreDayId = await insertCentreDay(pool, { centreId, serviceDate: TODAY });
    const farmerId = await insertFarmerWithLand(pool, { extentAcres: 2 });
    await insertBooking(pool, {
      centreDayId,
      farmerId,
      status: 'completed',
      checkedInAt: '2026-09-04T09:00:00Z',
      completedAt: '2026-09-04T09:15:00Z', // 15 minutes
    });

    await runNightlyReallocation(pool, { today: TODAY });

    const centre = await pool.query('SELECT service_time_ewma_minutes FROM centres WHERE id = $1', [centreId]);
    expect(Number(centre.rows[0].service_time_ewma_minutes)).toBe(15); // seeded, no prior value
  });

  test('recomputes and persists capacity for D+1..D+7 even with nothing to defer', async () => {
    const pool = setup();
    const centreId = await insertCentre(pool);
    for (let offset = 1; offset <= 7; offset++) {
      const date = new Date(`${TODAY}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      await insertDailyInputs(pool, { centreId, serviceDate: date.toISOString().slice(0, 10) });
    }

    const plan = await runNightlyReallocation(pool, { today: TODAY });

    expect(plan.centreDayUpserts).toHaveLength(7);
    const centreDays = await pool.query('SELECT service_date, bookable_capacity FROM centre_day WHERE centre_id = $1', [
      centreId,
    ]);
    expect(centreDays.rowCount).toBe(7);
  });
});
