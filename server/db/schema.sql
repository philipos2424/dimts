-- Dimts schema (SPEC.md §5)

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',            -- free | pro | business
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  user_phone TEXT NOT NULL,
  destination TEXT NOT NULL,
  twilio_call_sid TEXT,
  status TEXT NOT NULL DEFAULT 'initiating',
  -- initiating | ringing | in-progress | missed | processing | ready | failed
  duration_sec INT,
  recording_url TEXT,
  transcript TEXT,
  transcript_data JSONB,                        -- full Scribe response
  language TEXT,
  language_probability FLOAT,
  summary TEXT,
  action_items JSONB,
  key_points JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_user_idx ON calls (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_minutes (
  user_id UUID REFERENCES users(id),
  month TEXT NOT NULL,                          -- 'YYYY-MM'
  minutes_used NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- Lookup path for the recording webhook when ?callId= is missing and we can
-- only match on Twilio's CallSid.
CREATE INDEX IF NOT EXISTS calls_twilio_sid_idx ON calls (twilio_call_sid);

-- Supports the stale-call reaper's scan for rows stuck in initiating/ringing.
CREATE INDEX IF NOT EXISTS calls_active_idx ON calls (status, created_at)
  WHERE status IN ('initiating', 'ringing', 'in-progress');

-- ---------------------------------------------------------------------------
-- Call agent: contacts, call direction, agent numbers
-- ---------------------------------------------------------------------------

-- The Twilio number a user publishes as their business line. Inbound calls
-- are matched to their owner through this column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_number TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  phone TEXT NOT NULL,
  display_name TEXT,
  company TEXT,
  name_source TEXT NOT NULL DEFAULT 'extracted',  -- user | extracted
  name_confidence FLOAT,
  notes TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_call_at TIMESTAMPTZ,
  UNIQUE (user_id, phone)
);

ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS next_moves JSONB;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS followups JSONB;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS followups_version INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS followup_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS processing_token UUID;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS processing_until TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS record_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_call_sid TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_consent_choice TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_consent_choice TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_start_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_sid TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS request_key TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_number TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS max_duration_sec INT NOT NULL DEFAULT 1800;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS budget_released BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS calls_request_key_idx ON calls(user_id, request_key) WHERE request_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS call_budget_lock (id INT PRIMARY KEY CHECK (id = 1));
INSERT INTO call_budget_lock(id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls (contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS agent_number_pool (
  phone TEXT PRIMARY KEY,
  provider_sid TEXT UNIQUE NOT NULL,
  voice_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_connect_version INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS google_oauth_requests (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('calendar', 'gmail')),
  phase TEXT NOT NULL CHECK (phase IN ('begin', 'state', 'confirm')),
  version INT NOT NULL,
  nonce_hash TEXT,
  encrypted_payload TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS google_connections (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('calendar', 'gmail')),
  encrypted_tokens TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, kind)
);
ALTER TABLE google_connections ADD COLUMN IF NOT EXISTS connection_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS calendar_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  connection_id UUID NOT NULL,
  proposal_version INT NOT NULL,
  meeting JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','unknown','failed')),
  event_id TEXT NOT NULL UNIQUE,
  event_url TEXT,
  error_code TEXT,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  connection_id UUID NOT NULL,
  proposal_version INT NOT NULL,
  email JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','unknown','failed')),
  message_key TEXT NOT NULL UNIQUE,
  draft_id TEXT,
  error_code TEXT,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
