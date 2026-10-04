-- Release 3: pricing, credits, retention and cost tracking.
-- Apply to the production Supabase project BEFORE deploying the pricing code.
-- Additive and safe to re-run: nothing is dropped or rewritten.
-- Supabase dashboard > SQL Editor > paste this whole file > Run.
BEGIN;

-- From PR #13 (auto-delete period) and PR #15 (own caller ID), merged after the
-- deployed build; the code reads them on every request, so make sure they exist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS retention_months INT CHECK (retention_months IN (3,6,12,24));
ALTER TABLE users ADD COLUMN IF NOT EXISTS caller_id_verified_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_id TEXT;

-- Plans and prepaid credits (server/lib/pricing.js)
ALTER TABLE calls ADD COLUMN IF NOT EXISTS billing_tier TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS plan_seconds INT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS surcharge_cents INT NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS overage_cents INT NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS est_cost_micros BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS number_release_at TIMESTAMPTZ;

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
CREATE TABLE IF NOT EXISTS billing_alerts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, alert_key)
);
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

-- Same lock-down as every other table: no Supabase Data API access (supabase-privacy.sql).
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_costs ENABLE ROW LEVEL SECURITY;

-- The app's backend role reaches them like the rest (supabase-backend-access.sql).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  credit_ledger, subscriptions, billing_events, billing_alerts, payments, provider_costs TO dimts_caller_backend;
GRANT USAGE ON SEQUENCE credit_ledger_id_seq TO dimts_caller_backend;
DO $$
DECLARE app_table TEXT;
BEGIN
  FOREACH app_table IN ARRAY ARRAY['credit_ledger','subscriptions','billing_events','billing_alerts','payments','provider_costs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS dimts_backend_access ON public.%I', app_table);
    EXECUTE format('CREATE POLICY dimts_backend_access ON public.%I FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true)', app_table);
  END LOOP;
END $$;

COMMIT;

-- Check: expect 6 rows, every one with rls = true and policies = 1.
SELECT c.relname AS table_name, c.relrowsecurity AS rls,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('credit_ledger','subscriptions','billing_events','billing_alerts','payments','provider_costs')
ORDER BY 1;
