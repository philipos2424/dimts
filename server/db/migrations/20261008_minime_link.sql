-- MiniMe link, 8 October 2026. Additive and safe to run twice.
-- When the owner promises a caller "I'll send it on Telegram", Dimts asks the
-- owner's MiniMe (Telegram business assistant) to send it.

CREATE TABLE IF NOT EXISTS minime_links (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL,
  business_name TEXT,
  auto_send BOOLEAN NOT NULL DEFAULT true,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One-time link tokens (only the hash is stored), valid for fifteen minutes.
CREATE TABLE IF NOT EXISTS minime_link_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes'
);
-- At most one Telegram send per call; the id is MiniMe's idempotency key.
CREATE TABLE IF NOT EXISTS telegram_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  draft TEXT NOT NULL,
  evidence JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','waiting','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_sends_user_idx ON telegram_sends (user_id, created_at DESC);

ALTER TABLE minime_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE minime_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_sends ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE minime_links, minime_link_tokens, telegram_sends TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.minime_links;
CREATE POLICY dimts_backend_access ON public.minime_links FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS dimts_backend_access ON public.minime_link_tokens;
CREATE POLICY dimts_backend_access ON public.minime_link_tokens FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS dimts_backend_access ON public.telegram_sends;
CREATE POLICY dimts_backend_access ON public.telegram_sends FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
