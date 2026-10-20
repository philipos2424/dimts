-- App-to-app calls, 21 October 2026. Additive and safe to run twice.
-- Apply BEFORE deploying code that reads these columns and table.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_calls_findable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE notification_devices ADD COLUMN IF NOT EXISTS app_calls_supported BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS route TEXT NOT NULL DEFAULT 'phone';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_route_check') THEN
    ALTER TABLE calls ADD CONSTRAINT calls_route_check CHECK (route IN ('phone','app'));
  END IF;
END $$;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS app_call_id UUID;
CREATE TABLE IF NOT EXISTS app_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id UUID NOT NULL REFERENCES users(id),
  callee_id UUID NOT NULL REFERENCES users(id),
  caller_call_id UUID REFERENCES calls(id),
  callee_call_id UUID REFERENCES calls(id),
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','connecting','connected','ended','declined','missed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
ALTER TABLE app_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_calls TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.app_calls;
CREATE POLICY dimts_backend_access ON public.app_calls FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
COMMIT;
