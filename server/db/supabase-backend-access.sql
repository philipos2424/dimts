-- Apply after schema.sql and supabase-privacy.sql, after an operator creates
-- dimts_caller_backend as a LOGIN role with a privately generated password.
-- The server authenticates/isolates app users; this role has no Data API grant,
-- role-management permission, or RLS bypass. Never grant it to anon/authenticated.
GRANT dimts_caller_backend TO postgres;
GRANT CONNECT ON DATABASE postgres TO dimts_caller_backend;
GRANT USAGE ON SCHEMA public TO dimts_caller_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  users, calls, usage_minutes, contacts, followup_events, call_budget_lock,
  sessions, agent_number_pool, auth_rate_limits, google_oauth_requests,
  google_connections, calendar_actions, email_actions, notification_devices,
  call_notifications, audit_events, rate_limits TO dimts_caller_backend;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO dimts_caller_backend;

DO $$
DECLARE app_table TEXT;
BEGIN
  FOREACH app_table IN ARRAY ARRAY[
    'users', 'calls', 'usage_minutes', 'contacts', 'followup_events',
    'call_budget_lock', 'sessions', 'agent_number_pool', 'auth_rate_limits',
    'google_oauth_requests', 'google_connections', 'calendar_actions',
    'email_actions', 'notification_devices', 'call_notifications', 'audit_events', 'rate_limits'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS dimts_backend_access ON public.%I', app_table);
    EXECUTE format('CREATE POLICY dimts_backend_access ON public.%I FOR ALL TO dimts_caller_backend USING (true) WITH CHECK (true)', app_table);
  END LOOP;
END $$;
