-- Security hardening (2026-10-06). Apply to production before deploying the
-- security-hardening branch. Idempotent.

-- Call content is encrypted at rest; a text index would keep a readable copy of every word.
DROP INDEX IF EXISTS calls_search_idx;

-- Signed-in devices: listed in Settings, revocable one by one or all at once.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_idx ON sessions (id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
