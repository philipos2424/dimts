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
ALTER TABLE calls ADD COLUMN IF NOT EXISTS processing_token UUID;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS processing_until TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS record_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_call_sid TEXT;

CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls (contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
