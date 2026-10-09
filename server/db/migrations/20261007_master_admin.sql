-- Operator console, 7 October 2026. Additive and safe to run twice.
-- Apply before deploying: the activity log, the data export and the console
-- read these columns and tables.

-- Columns the console reads that arrive with later releases (same statements; no-ops if present).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_idx ON sessions (id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS reason TEXT;
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, created_at DESC);
-- The daily retention job deletes entries older than a year (privacy policy).
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at);

-- Operator console sign-in with a passkey (Face ID, fingerprint, device PIN): no text code.
CREATE TABLE IF NOT EXISTS admin_passkeys (
  id TEXT PRIMARY KEY,                       -- WebAuthn credential ID, base64url
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,                  -- COSE public key, base64url; no secret is stored
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS admin_passkeys_user_idx ON admin_passkeys (user_id);
-- One-time challenges, valid for five minutes.
CREATE TABLE IF NOT EXISTS admin_challenges (
  challenge TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('register','login')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes'
);
ALTER TABLE admin_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_passkeys, admin_challenges TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.admin_passkeys;
CREATE POLICY dimts_backend_access ON public.admin_passkeys FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS dimts_backend_access ON public.admin_challenges;
CREATE POLICY dimts_backend_access ON public.admin_challenges FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
