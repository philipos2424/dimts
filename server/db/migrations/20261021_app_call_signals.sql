-- App-to-app call signalling, 21 October 2026. Additive and safe to run twice.
-- Apply BEFORE deploying code that reads this table. Requires 20261021_app_calls.sql first.
BEGIN;
CREATE TABLE IF NOT EXISTS app_call_signals (
  id BIGSERIAL PRIMARY KEY,
  app_call_id UUID NOT NULL REFERENCES app_calls(id) ON DELETE CASCADE,
  from_user UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('offer','answer','candidate','bye','recording-stopped')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_call_signals_call_idx ON app_call_signals (app_call_id, id);
ALTER TABLE app_call_signals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_call_signals TO dimts_caller_backend;
GRANT USAGE ON SEQUENCE app_call_signals_id_seq TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.app_call_signals;
CREATE POLICY dimts_backend_access ON public.app_call_signals FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
COMMIT;
