-- SIH 26032 -- Kisan Slot
-- Initial schema: centres, pre-seeded land records, farmer registration,
-- daily capacity inputs, derived centre-day capacity, bookings, J-Forms
-- and itemised payment deductions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Procurement centres.
CREATE TABLE centres (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    code         TEXT NOT NULL UNIQUE,
    centre_type  TEXT NOT NULL CHECK (centre_type IN ('apmc_mandi', 'pacs', 'ikp')),
    district     TEXT NOT NULL,
    state        TEXT NOT NULL,
    latitude     NUMERIC(9, 6) NOT NULL,
    longitude    NUMERIC(9, 6) NOT NULL,
    -- Observed average minutes/lot, exponentially weighted -- updated
    -- nightly from today's completed lots. NULL until the first
    -- observation. Distinct from centre_daily_inputs' planning inputs,
    -- which are entered by hand; this is what actually happened.
    service_time_ewma_minutes  NUMERIC(6, 2),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
-- land_record_id is nullable because a Dharani lookup can fail to find a
-- match at all -- that has to be representable, not rejected at the door.
-- is_tenant marks a farmer who cultivates land under someone else's
-- record (land_records.farmer_name will differ from farmers.farmer_name).
CREATE TABLE farmers (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_name                TEXT NOT NULL,
    land_record_id             UUID REFERENCES land_records(id),
    is_tenant                  BOOLEAN NOT NULL DEFAULT false,
    phone                      TEXT NOT NULL UNIQUE,
    bank_account_number        TEXT,
    bank_ifsc                  TEXT,
    bank_account_holder_name   TEXT,
    last_season_dbt_status     TEXT CHECK (last_season_dbt_status IN ('success', 'failed')),
    registered_channel         TEXT NOT NULL CHECK (registered_channel IN ('app', 'sms', 'ivr', 'counter')),
    status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    registered_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw operational parameters that feed the capacity engine, one row per
-- centre per service date. Nothing here is a slot count -- the engine
-- derives that as min() across these constraints.
--
-- yard_capacity_tonnes is the yard's total physical capacity;
-- undispatched_tonnes is stock already sitting in it from prior days.
-- The capacity engine is given (yard_capacity_tonnes - undispatched_tonnes)
-- as its yardCapacityTonnes input -- it only ever sees space actually
-- available, not the yard's nameplate size.
CREATE TABLE centre_daily_inputs (
    id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id                           UUID NOT NULL REFERENCES centres(id),
    service_date                        DATE NOT NULL,

    weighing_mode                       TEXT NOT NULL DEFAULT 'weighbridge'
                                             CHECK (weighing_mode IN ('weighbridge', 'platform')),
    weighbridge_operating_minutes       INTEGER NOT NULL CHECK (weighbridge_operating_minutes > 0),
    weighbridge_avg_cycle_minutes       NUMERIC(6, 2) CHECK (weighbridge_avg_cycle_minutes > 0),
    seconds_per_bag                     NUMERIC(6, 2) CHECK (seconds_per_bag > 0),
    avg_bags_per_lot                    INTEGER CHECK (avg_bags_per_lot > 0),

    hamali_gang_count                   INTEGER NOT NULL CHECK (hamali_gang_count >= 0),
    hamali_bags_per_gang_per_day        INTEGER NOT NULL CHECK (hamali_bags_per_gang_per_day >= 0),

    bags_per_truck                      INTEGER NOT NULL CHECK (bags_per_truck > 0),
    gunny_bags_available                 INTEGER NOT NULL CHECK (gunny_bags_available >= 0),

    truck_evacuation_capacity           INTEGER NOT NULL CHECK (truck_evacuation_capacity >= 0),

    yard_capacity_tonnes                NUMERIC(8, 2) NOT NULL CHECK (yard_capacity_tonnes > 0),
    undispatched_tonnes                 NUMERIC(8, 2) NOT NULL DEFAULT 0 CHECK (undispatched_tonnes >= 0),
    avg_truck_load_tonnes               NUMERIC(6, 2) NOT NULL CHECK (avg_truck_load_tonnes > 0),

    moisture_meter_count                INTEGER NOT NULL DEFAULT 0 CHECK (moisture_meter_count >= 0),
    moisture_tests_per_meter_per_day    INTEGER NOT NULL DEFAULT 0 CHECK (moisture_tests_per_meter_per_day >= 0),

    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (centre_id, service_date),
    CHECK (
        (weighing_mode = 'weighbridge' AND weighbridge_avg_cycle_minutes IS NOT NULL)
        OR
        (weighing_mode = 'platform' AND seconds_per_bag IS NOT NULL AND avg_bags_per_lot IS NOT NULL)
    ),
    CHECK (undispatched_tonnes <= yard_capacity_tonnes)
);

CREATE INDEX idx_centre_daily_inputs_service_date ON centre_daily_inputs (service_date);

-- Derived output of the capacity engine, persisted per centre per date so
-- booking can happen against a stable number instead of recomputing live.
-- This is capacity, not a bookable time slot -- everything referencing a
-- centre's day-level capacity points here, and carries no capacity fields
-- of its own.
--
-- bags_capacity / bags_booked are the actual concurrency-safe reservation
-- ledger: bookable_capacity (trucks/day) x bags_per_truck gives
-- bags_capacity once, at compute time; every booking atomically claims
-- its bags via UPDATE ... SET bags_booked = bags_booked + $n WHERE
-- bags_booked + $n <= bags_capacity. That single guarded UPDATE is what
-- makes two concurrent bookings for the last slot resolve to exactly one
-- winner -- no explicit row lock needed, and the CHECK below is a second
-- line of defense against ever going over.
CREATE TABLE centre_day (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id             UUID NOT NULL REFERENCES centres(id),
    service_date          DATE NOT NULL,

    total_capacity        INTEGER NOT NULL CHECK (total_capacity >= 0),
    walk_in_reserved       INTEGER NOT NULL CHECK (walk_in_reserved >= 0),
    bookable_capacity     INTEGER NOT NULL CHECK (bookable_capacity >= 0),

    bags_capacity         NUMERIC(10, 2) NOT NULL CHECK (bags_capacity >= 0),
    bags_booked           NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (bags_booked >= 0),

    binding_constraint    TEXT NOT NULL CHECK (binding_constraint IN (
                               'weighbridge', 'hamali', 'gunny', 'truckEvacuation', 'yardSpace', 'moistureTesting'
                           )),
    constraint_breakdown  JSONB NOT NULL,

    computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (centre_id, service_date),
    CHECK (bags_booked <= bags_capacity)
);

CREATE INDEX idx_centre_day_service_date ON centre_day (service_date);

-- Bookings against a centre-day's capacity. No capacity fields live here --
-- they belong to centre_day alone. is_walk_in draws from the reserved
-- walk-in pool rather than the pre-booked pool.
CREATE TABLE bookings (
    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_day_id                UUID NOT NULL REFERENCES centre_day(id),
    farmer_id                    UUID NOT NULL REFERENCES farmers(id),
    token                        TEXT NOT NULL UNIQUE,
    -- Farmer-declared intent at booking time -- not the weighed actual,
    -- which lands on the j_form. Compared against a land-record-derived
    -- yield estimate to flag implausible declarations.
    declared_quantity_quintals   NUMERIC(8, 2) CHECK (declared_quantity_quintals > 0),
    -- What this booking actually claimed against centre_day.bags_booked
    -- (declared_quantity_quintals * 2.5, snapshotted at booking time).
    bags_reserved                NUMERIC(8, 2) NOT NULL CHECK (bags_reserved > 0),
    booking_channel              TEXT NOT NULL CHECK (booking_channel IN ('app', 'sms', 'ivr', 'counter')),
    is_walk_in                   BOOLEAN NOT NULL DEFAULT false,
    -- 'deferred' is system-initiated (nightly reallocation bumped this
    -- booking for lack of capacity) -- distinct from farmer-initiated
    -- 'cancelled', so it can be reported and scored differently.
    status                       TEXT NOT NULL DEFAULT 'booked' CHECK (status IN (
                                      'booked', 'checked_in', 'completed', 'cancelled', 'no_show', 'deferred'
                                  )),
    booked_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_in_at                TIMESTAMPTZ,
    completed_at                 TIMESTAMPTZ,
    -- Set once the nightly job has released this booking's bags back into
    -- centre_day.bags_booked (a no-show, or a deferral) -- keeps the
    -- release idempotent across repeated job runs.
    capacity_released_at         TIMESTAMPTZ,

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

-- Audit trail for system-initiated deferrals, and the source of a
-- farmer's prior-deferrals count for future allocation scoring.
CREATE TABLE deferrals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id              UUID NOT NULL REFERENCES bookings(id),
    farmer_id               UUID NOT NULL REFERENCES farmers(id),
    centre_id               UUID NOT NULL REFERENCES centres(id),
    original_service_date   DATE NOT NULL,
    score                   NUMERIC(10, 2) NOT NULL,
    reason                  TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deferrals_farmer_id ON deferrals (farmer_id);

-- Mock notification gateway. The reallocation job (and, eventually,
-- other flows) write here instead of calling a real SMS/IVR provider --
-- matches the offline-first non-negotiable without wiring a live gateway.
CREATE TABLE messages (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id            UUID NOT NULL REFERENCES farmers(id),
    related_booking_id   UUID REFERENCES bookings(id),
    channel              TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'ivr', 'app')),
    body                 TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_farmer_id ON messages (farmer_id);
