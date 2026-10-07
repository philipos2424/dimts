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
ALTER TABLE calls ADD COLUMN IF NOT EXISTS processing_requested_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_recording_url TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS record_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_mode TEXT NOT NULL DEFAULT 'all_parties' CHECK (consent_mode IN ('all_parties','owner_only'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_scope TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS other_party_notice_issued_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_call_sid TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_consent_choice TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS child_consent_choice TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_start_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_sid TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_account_sid TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_deletion_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_deletion_error TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_deletion_token UUID;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_deletion_until TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_deletion_attempted_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_deleted_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_lookup_until TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_lookup_token UUID;
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

CREATE TABLE IF NOT EXISTS notification_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  push_token TEXT NOT NULL UNIQUE,
  disabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS call_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  ticket_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(call_id, device_id)
);

-- Release 1: one notice consent rule, terms acceptance and account deletion.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_consent_mode_check;
ALTER TABLE calls ADD CONSTRAINT calls_consent_mode_check CHECK (consent_mode IN ('all_parties','owner_only','notice'));

-- Release 1: who did what to which data. No content, only references.
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events(user_id, created_at DESC);

-- Release 1: durable request counters shared by every function instance.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- Release 1: call audio moves off Twilio into private EU storage.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_object_key TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_archived_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_archive_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_archive_attempted_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS storage_deletion_status TEXT;

-- Release 1: people who were recorded can ask businesses to delete their data.
CREATE TABLE IF NOT EXISTS privacy_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS privacy_request_targets (
  request_id UUID NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (request_id, user_id)
);

-- Release 2: verified agreements, contradictions, recaps and the owner's language.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agreements JSONB;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS conflicts JSONB;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recap TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','am'));
CREATE TABLE IF NOT EXISTS promise_states (
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  item_index INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','done','dismissed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, item_index)
);
-- Call content is encrypted at rest; a text index would keep a readable copy of every word.
DROP INDEX IF EXISTS calls_search_idx;
-- A message left after a missed incoming call: one mono channel, the caller only.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS voicemail BOOLEAN NOT NULL DEFAULT false;
-- Storage limitation: calls older than this many months are deleted automatically. NULL keeps them until deleted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS retention_months INT CHECK (retention_months IN (3,6,12,24));
-- New accounts keep calls for a year unless they choose otherwise; existing accounts keep their choice.
ALTER TABLE users ALTER COLUMN retention_months SET DEFAULT 12;
-- IANA time zone from the owner's phone, so "tomorrow at noon" becomes the right moment.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;
-- Set on the first call of a free account: 21 days of Pro (pricing.js TRIAL_DAYS).
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
-- The owner's own mobile shown as caller ID once the carrier has verified it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS caller_id_verified_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_id TEXT;

-- Release 3: plans and prepaid credits through Polar (lib/pricing.js).
-- What a call may cost is fixed when it is reserved, so later price changes
-- never reprice a call already under way.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS billing_tier TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS plan_seconds INT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS surcharge_cents INT NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS overage_cents INT NOT NULL DEFAULT 0;
-- Append-only. The balance is the sum; source_key makes every grant and charge happen once.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  amount_cents INT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('purchase','call','refund','grant')),
  source_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger(user_id);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  product_key TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('pro','business')),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month','year')),
  status TEXT NOT NULL,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  provider_modified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);
CREATE TABLE IF NOT EXISTS billing_events (
  webhook_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Release 3b: retention and unit economics.
-- A free account keeps its business number for 30 days after a paid plan ends.
ALTER TABLE users ADD COLUMN IF NOT EXISTS number_release_at TIMESTAMPTZ;
-- One push per threshold and period; the key says which (e.g. minutes80:2026-10).
CREATE TABLE IF NOT EXISTS billing_alerts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, alert_key)
);
-- Every paid Polar order, so revenue can be set against cost.
CREATE TABLE IF NOT EXISTS payments (
  order_id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  product_key TEXT,
  currency TEXT NOT NULL,
  total_amount INT NOT NULL,
  tax_amount INT NOT NULL DEFAULT 0,
  refunded_amount INT NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- What carriers actually billed, per day, from their detail records.
CREATE TABLE IF NOT EXISTS provider_costs (
  day DATE NOT NULL,
  provider TEXT NOT NULL,
  record_type TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT '',
  records INT NOT NULL,
  billed_sec BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, provider, record_type, country_code)
);
-- Our own estimate per finished call (carrier legs + recording + transcription), in micro-dollars.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS est_cost_micros BIGINT;

-- Signed-in devices: listed in Settings, revocable one by one or all at once.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_idx ON sessions (id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
