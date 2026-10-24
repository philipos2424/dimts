-- Choose which incoming calls are recorded.
-- Additive and safe to re-run; existing users keep recording every incoming call.
-- Apply BEFORE deploying code that reads these columns.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS incoming_recording TEXT NOT NULL DEFAULT 'all' CHECK (incoming_recording IN ('all','chosen'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS recording_pref TEXT NOT NULL DEFAULT 'default' CHECK (recording_pref IN ('default','record','skip'));
COMMIT;
