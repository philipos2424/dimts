-- App-to-app call lifecycle, 22 October 2026. Additive and safe to run twice.
-- Apply BEFORE deploying code that reads these columns. Requires 20261021_app_calls.sql first.
BEGIN;
ALTER TABLE app_calls ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ;
ALTER TABLE app_calls ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
COMMIT;
