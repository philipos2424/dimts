CREATE TABLE IF NOT EXISTS file_actions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'needs_details' CHECK (status IN
    ('needs_details','ready_for_review','sending','sent','failed','unknown','dismissed')),
  execution_id UUID,
  message_id BIGINT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(call_id, source_hash, source_index)
);
CREATE INDEX IF NOT EXISTS file_actions_owner ON file_actions(user_id, created_at DESC);
ALTER TABLE file_actions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON file_actions TO dimts_caller_backend;
DROP POLICY IF EXISTS dimts_backend_access ON file_actions;
CREATE POLICY dimts_backend_access ON file_actions FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true);
