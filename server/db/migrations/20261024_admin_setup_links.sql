-- Apply before deploying the admin setup-link change. Safe to run twice.
-- Used operator setup links, kept permanently (SHA-256 of the secret, never the secret).
-- "Already used" was inferred from audit events, which are deleted after a year and
-- whose writes can fail; this table cannot be changed or emptied by the app.
CREATE TABLE IF NOT EXISTS admin_setup_links (
  link_id TEXT PRIMARY KEY CHECK (link_id ~ '^[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE admin_setup_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_setup_links FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON admin_setup_links FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON admin_setup_links FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dimts_caller_backend') THEN
    GRANT SELECT, INSERT ON admin_setup_links TO dimts_caller_backend;
    DROP POLICY IF EXISTS dimts_backend_access ON admin_setup_links;
    CREATE POLICY dimts_backend_access ON admin_setup_links FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
  END IF;
END $$;
