-- Launch sprint, 7 October 2026. Additive and safe to run twice.
-- New accounts keep calls for 12 months by default; existing accounts keep their setting.
ALTER TABLE users ALTER COLUMN retention_months SET DEFAULT 12;
-- The owner's IANA time zone, sent by the app; promise due dates are read in it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;
-- The 21-day Pro trial, started by the first call of a free account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
