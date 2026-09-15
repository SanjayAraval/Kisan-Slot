-- SIH 26032 -- Kisan Slot
-- Unified login shell: employee accounts (officers/operators), farmer OTP
-- codes, and the fields self-service/assisted registration needs.
-- Builds on 001_init_schema.sql.

-- Officers and assisted operators -- the "employee ID + password" login.
-- Farmers never get a row here; they authenticate by mobile OTP instead
-- (see otp_codes).
CREATE TABLE employees (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('centre_officer', 'district_officer', 'operator')),
    -- Required for centre_officer and operator (their one assigned
    -- centre); NULL for district_officer, who is scoped by district
    -- instead of a single centre.
    centre_id       UUID REFERENCES centres(id),
    -- Required for district_officer; NULL otherwise. Free text matched
    -- against centres.district rather than a foreign key -- district
    -- isn't its own table here.
    district        TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (role IN ('centre_officer', 'operator') AND centre_id IS NOT NULL AND district IS NULL)
        OR
        (role = 'district_officer' AND district IS NOT NULL AND centre_id IS NULL)
    )
);

-- One-time codes for farmer login and registration. Keyed by mobile, not
-- farmer_id -- a registration OTP is requested before any farmer row
-- exists. This is the mock SMS gateway: nothing here calls a real
-- provider, and the dev-mode API response echoes the code directly (see
-- authRoutes.js) instead of requiring an actual phone.
CREATE TABLE otp_codes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile        TEXT NOT NULL,
    code          TEXT NOT NULL,
    purpose       TEXT NOT NULL CHECK (purpose IN ('login', 'registration')),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_codes_mobile ON otp_codes (mobile, purpose);

-- messages.farmer_id becomes optional -- an OTP sent to a mobile number
-- during registration has no farmer row to attach to yet. `mobile`
-- carries the destination in that case; an existing farmer's messages
-- (reallocation notices etc.) still use farmer_id exactly as before.
ALTER TABLE messages ALTER COLUMN farmer_id DROP NOT NULL;
ALTER TABLE messages ADD COLUMN mobile TEXT;
ALTER TABLE messages ADD CONSTRAINT messages_target_check CHECK (farmer_id IS NOT NULL OR mobile IS NOT NULL);

-- Registration additions.
--   aadhaar_number: collected by the registration flow but previously had
--     nowhere to land.
--   registered_by_operator_id: which logged-in operator ran an assisted
--     registration, for audit -- NULL for a farmer's own self-service
--     registration. The server stamps this from the verified session,
--     never from client input.
--   claimed_*: what the farmer/operator declared for land when the
--     khasra lookup finds no matching land_records row. Kept distinct
--     from a real linked record -- land_record_id stays NULL, which is
--     exactly the existing needsOfficerReview signal (see
--     farmerService.js) -- no separate "pending" status needed.
ALTER TABLE farmers ADD COLUMN aadhaar_number TEXT;
ALTER TABLE farmers ADD COLUMN registered_by_operator_id UUID REFERENCES employees(id);
ALTER TABLE farmers ADD COLUMN claimed_land_record_number TEXT;
ALTER TABLE farmers ADD COLUMN claimed_extent_acres NUMERIC(6, 2);
ALTER TABLE farmers ADD COLUMN claimed_crop TEXT;
