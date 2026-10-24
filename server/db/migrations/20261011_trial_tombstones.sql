-- No user ID or phone: only a keyed fingerprint and the time prior trial use was
-- recorded on deletion. Retained for 12 months from deletion, then removed daily.
CREATE TABLE IF NOT EXISTS trial_tombstones (
  phone_hash TEXT PRIMARY KEY CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  trial_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trial_tombstones_expiry_idx ON trial_tombstones(trial_used_at);
ALTER TABLE trial_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trial_tombstones FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON trial_tombstones FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON trial_tombstones FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dimts_caller_backend') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON trial_tombstones TO dimts_caller_backend;
    DROP POLICY IF EXISTS dimts_backend_access ON trial_tombstones;
    CREATE POLICY dimts_backend_access ON trial_tombstones FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
  END IF;
END $$;
