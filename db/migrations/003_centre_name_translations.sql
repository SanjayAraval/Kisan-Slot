-- SIH 26032 -- Kisan Slot
-- Transliterated centre names, so a Hindi or Telugu reader can identify
-- their own centre instead of only ever seeing the English name.
-- Builds on 001_init_schema.sql.

ALTER TABLE centres ADD COLUMN name_hi TEXT;
ALTER TABLE centres ADD COLUMN name_te TEXT;

-- Existing rows (and any centre inserted before its transliteration is
-- known) fall back to the English name rather than leaving a blank --
-- always something to show, never a missing label.
UPDATE centres SET name_hi = name WHERE name_hi IS NULL;
UPDATE centres SET name_te = name WHERE name_te IS NULL;

ALTER TABLE centres ALTER COLUMN name_hi SET NOT NULL;
ALTER TABLE centres ALTER COLUMN name_te SET NOT NULL;
