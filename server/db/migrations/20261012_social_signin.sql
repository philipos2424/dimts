-- Social sign-in, 12 October 2026. Additive and safe to run twice. Apply before deploying.
-- Sign in with Google, Apple, Telegram or ChatGPT (2026-10-12). Only a hash
-- of the provider's subject ID is kept: no name, email or picture.
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google','apple','telegram','chatgpt')),
  subject_hash TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY (provider, subject_hash)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);
-- One-time steps of a social sign-in: begin → state → done → link (phone confirmation).
CREATE TABLE IF NOT EXISTS social_signin_requests (
  token_hash TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('begin','state','done','link')),
  provider TEXT NOT NULL,
  app_challenge TEXT,
  return_to TEXT,
  cookie_hash TEXT,
  subject_hash TEXT,
  phone_hint TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS social_signin_requests_expiry_idx ON social_signin_requests (expires_at);
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_signin_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_identities, social_signin_requests TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.user_identities;
CREATE POLICY dimts_backend_access ON public.user_identities FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS dimts_backend_access ON public.social_signin_requests;
CREATE POLICY dimts_backend_access ON public.social_signin_requests FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);

-- Apple grants are encrypted independently of account rows so failed revocation
-- can be retried after account deletion. Successful revocation erases the row.
CREATE TABLE IF NOT EXISTS apple_signin_credentials (
  subject_hash TEXT PRIMARY KEY,
  encrypted_token TEXT NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  revoke_after TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  lease_id UUID,
  lease_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS apple_signin_revocation_idx ON apple_signin_credentials (revoke_after,next_attempt_at);
ALTER TABLE apple_signin_credentials ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON apple_signin_credentials TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.apple_signin_credentials;
CREATE POLICY dimts_backend_access ON public.apple_signin_credentials FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);

-- Short-lived security records reject replay and callbacks issued before revocation.
CREATE TABLE IF NOT EXISTS apple_signin_events (
  notification_id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apple_signin_events_subject_idx ON apple_signin_events (subject_hash,event_time);
ALTER TABLE apple_signin_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON apple_signin_events TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.apple_signin_events;
CREATE POLICY dimts_backend_access ON public.apple_signin_events FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
