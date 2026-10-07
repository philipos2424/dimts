-- Operator console, 7 October 2026. Additive and safe to run twice.
-- Apply before deploying the master-admin branch (audit() writes reason only
-- for staff actions, so ordinary audit entries keep working either way).
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS reason TEXT;
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, created_at DESC);
-- The daily retention job deletes entries older than a year (privacy policy).
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at);
