-- Onboarding demo calls, 19 October 2026. Additive and safe to run twice.
-- Apply before deploying: POST /api/calls/demo writes calls.demo.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS calls_demo_idx ON calls(user_id) WHERE demo;
