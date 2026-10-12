-- Marketing site waitlist, 12 October 2026. Additive and safe to run twice.
-- Apply before deploying: POST /api/waitlist writes here.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,
  platform TEXT CHECK (platform IN ('iphone','android','web')),
  work TEXT,
  country TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE waitlist TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.waitlist;
CREATE POLICY dimts_backend_access ON public.waitlist FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
