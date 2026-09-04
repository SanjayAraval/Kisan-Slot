-- SIH 26032 -- Kisan Slot
-- Initial schema: centres, pre-seeded land records, farmer registration,
-- daily capacity inputs, derived centre-day capacity, bookings, J-Forms
-- and itemised payment deductions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Procurement centres.
CREATE TABLE centres (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    district    TEXT NOT NULL,
    state       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Land records mirrored from Dharani (mocked integration). Read-only from
-- our side -- this table is a local cache of externally sourced data, not
-- something farmers fill in.
CREATE TABLE land_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    land_record_number  TEXT NOT NULL UNIQUE,
    farmer_name         TEXT NOT NULL,
    father_name         TEXT,
    village             TEXT NOT NULL,
    survey_number       TEXT NOT NULL,
    extent_acres        NUMERIC(6, 2) NOT NULL CHECK (extent_acres > 0),
    crop                TEXT NOT NULL,
    source              TEXT NOT NULL DEFAULT 'dharani_mock',
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registration confirms a pre-seeded land record; it is not data entry.
CREATE TABLE farmers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    land_record_id      UUID NOT NULL REFERENCES land_records(id),
    phone               TEXT NOT NULL UNIQUE,
    registered_channel  TEXT NOT NULL CHECK (registered_channel IN ('app', 'sms', 'ivr', 'counter')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    registered_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw operational parameters that feed the capacity engine, one row per
-- centre per service date. Nothing here is a slot count -- the engine
-- derives that as min() across these constraints.
CREATE TABLE centre_daily_inputs (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id                       UUID NOT NULL REFERENCES centres(id),
    service_date                    DATE NOT NULL,

    weighbridge_operating_minutes   INTEGER NOT NULL CHECK (weighbridge_operating_minutes > 0),
    weighbridge_avg_cycle_minutes   NUMERIC(6, 2) NOT NULL CHECK (weighbridge_avg_cycle_minutes > 0),

    hamali_gang_count               INTEGER NOT NULL CHECK (hamali_gang_count >= 0),
    hamali_bags_per_gang_per_day    INTEGER NOT NULL CHECK (hamali_bags_per_gang_per_day >= 0),

    bags_per_truck                  INTEGER NOT NULL CHECK (bags_per_truck > 0),
    gunny_bags_available             INTEGER NOT NULL CHECK (gunny_bags_available >= 0),

    truck_evacuation_capacity       INTEGER NOT NULL CHECK (truck_evacuation_capacity >= 0),

    yard_capacity_tonnes            NUMERIC(8, 2) NOT NULL CHECK (yard_capacity_tonnes > 0),
    avg_truck_load_tonnes           NUMERIC(6, 2) NOT NULL CHECK (avg_truck_load_tonnes > 0),

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (centre_id, service_date)
);

CREATE INDEX idx_centre_daily_inputs_service_date ON centre_daily_inputs (service_date);

-- Derived output of the capacity engine, persisted per centre per date so
-- booking can happen against a stable number instead of recomputing live.
-- This is capacity, not a bookable time slot -- everything referencing a
-- centre's day-level capacity points here, and carries no capacity fields
-- of its own.
CREATE TABLE centre_day (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id             UUID NOT NULL REFERENCES centres(id),
    service_date          DATE NOT NULL,

    total_capacity        INTEGER NOT NULL CHECK (total_capacity >= 0),
    walk_in_reserved       INTEGER NOT NULL CHECK (walk_in_reserved >= 0),
    bookable_capacity     INTEGER NOT NULL CHECK (bookable_capacity >= 0),

    binding_constraint    TEXT NOT NULL CHECK (binding_constraint IN (
                               'weighbridge', 'hamali', 'gunny', 'truckEvacuation', 'yardSpace'
                           )),
    constraint_breakdown  JSONB NOT NULL,

    computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (centre_id, service_date)
);

CREATE INDEX idx_centre_day_service_date ON centre_day (service_date);

-- Bookings against a centre-day's capacity. No capacity fields live here --
-- they belong to centre_day alone. is_walk_in draws from the reserved
-- walk-in pool rather than the pre-booked pool.
CREATE TABLE bookings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_day_id    UUID NOT NULL REFERENCES centre_day(id),
    farmer_id        UUID NOT NULL REFERENCES farmers(id),
    booking_channel  TEXT NOT NULL CHECK (booking_channel IN ('app', 'sms', 'ivr', 'counter')),
    is_walk_in       BOOLEAN NOT NULL DEFAULT false,
    status           TEXT NOT NULL DEFAULT 'booked' CHECK (status IN (
                          'booked', 'checked_in', 'completed', 'cancelled', 'no_show'
                      )),
    booked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (centre_day_id, farmer_id)
);

CREATE INDEX idx_bookings_status ON bookings (status);

-- J-Forms are immutable once issued. A correction issues a new row that
-- supersedes the prior one rather than mutating it.
CREATE TABLE j_forms (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id             UUID NOT NULL REFERENCES bookings(id),
    j_form_number          TEXT NOT NULL UNIQUE,
    quintals_procured      NUMERIC(8, 2) NOT NULL CHECK (quintals_procured > 0),
    msp_rate               NUMERIC(8, 2) NOT NULL CHECK (msp_rate > 0),
    gross_amount           NUMERIC(10, 2) NOT NULL CHECK (gross_amount >= 0),
    supersedes_j_form_id   UUID REFERENCES j_forms(id),
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
    issued_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_j_forms_booking_id ON j_forms (booking_id);

-- Itemised deductions between MSP gross and net payable. Sum per j_form_id
-- gives the total deduction; gross_amount - sum(amount) gives net payable.
CREATE TABLE payment_deductions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    j_form_id       UUID NOT NULL REFERENCES j_forms(id),
    deduction_type  TEXT NOT NULL,
    amount          NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_deductions_j_form_id ON payment_deductions (j_form_id);
