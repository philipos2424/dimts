-- App-to-app call audio, 23 October 2026. Additive and safe to run twice.
-- Apply BEFORE deploying code that reads these columns or this table. Requires 20261021_app_calls.sql first.
BEGIN;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS own_audio_complete_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS own_audio_offset_ms INT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS own_audio_mime TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS notes_partial BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS app_call_audio_parts (
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  total INT NOT NULL CHECK (total BETWEEN 1 AND 40),
  sha256 TEXT NOT NULL,
  size INT NOT NULL CHECK (size BETWEEN 1 AND 1048576),
  encrypted BOOLEAN NOT NULL DEFAULT false,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, idx),
  CHECK (idx >= 0 AND idx < total)
);
CREATE INDEX IF NOT EXISTS app_call_audio_parts_created_idx ON app_call_audio_parts (created_at);
ALTER TABLE app_call_audio_parts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_call_audio_parts TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON public.app_call_audio_parts;
CREATE POLICY dimts_backend_access ON public.app_call_audio_parts FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
COMMIT;
