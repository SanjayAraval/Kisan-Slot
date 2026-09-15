-- SIH 26032 -- Kisan Slot
-- A watermark on centre_daily_inputs so the declaration screen can detect
-- a stale resubmit -- e.g. an officer loads tonight's declaration, bags
-- are released from the district dashboard in the meantime, and the
-- officer then submits their now-outdated form, silently reverting the
-- just-released capacity with no warning. Builds on 001_init_schema.sql.

ALTER TABLE centre_daily_inputs ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
