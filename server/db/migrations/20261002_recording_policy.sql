-- Additive: existing calls retain the all-party policy. No user data changes.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_mode TEXT NOT NULL DEFAULT 'all_parties' CHECK (consent_mode IN ('all_parties','owner_only'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_scope TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS other_party_notice_issued_at TIMESTAMPTZ;
