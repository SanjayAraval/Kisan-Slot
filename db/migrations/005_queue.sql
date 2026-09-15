-- SIH 26032 -- Kisan Slot
-- Live gate queue: marks a checked-in lot as no longer waiting once the
-- centre officer calls it forward ("mark served" on the live queue
-- screen). Deliberately its own column, not a bookings.status value --
-- the lot is still exactly 'checked_in' as far as the rest of the
-- pipeline (moisture test, weighment, J-Form, dispatch) is concerned;
-- this only tracks whether it has left the front-of-gate queue, which
-- those later stages don't otherwise have a way to express. Builds on
-- 001_init_schema.sql.

ALTER TABLE bookings ADD COLUMN queue_served_at TIMESTAMPTZ;
