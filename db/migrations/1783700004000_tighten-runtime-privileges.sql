-- Up Migration

-- New migrator-owned objects must remain inaccessible until their migration
-- grants an explicit runtime whitelist.
ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM classhub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM classhub_app;

-- Reset privileges accumulated through the former broad defaults and the
-- early foundation grants, then rebuild the application whitelist.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM classhub_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM classhub_app;

GRANT SELECT, INSERT, UPDATE ON
  users,
  user_consents,
  email_verification_tokens,
  password_reset_tokens,
  sessions
  TO classhub_app;

GRANT SELECT, INSERT, DELETE ON api_idempotency_keys TO classhub_app;

GRANT SELECT ON teacher_profiles, schools, meals TO classhub_app;
-- Class creation locks the chosen school row while it derives the allowed
-- grade range. A harmless column-level UPDATE grant enables FOR UPDATE without
-- allowing the runtime role to alter school identity or imported content.
GRANT UPDATE (updated_at) ON schools TO classhub_app;

GRANT SELECT, INSERT, UPDATE ON
  classes,
  class_members,
  class_invite_codes,
  notices,
  supplies,
  schedules
  TO classhub_app;

GRANT SELECT, INSERT ON class_member_status_history, audit_logs TO classhub_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  notice_reads,
  supply_checks
  TO classhub_app;

GRANT USAGE ON SEQUENCE
  users_id_seq,
  user_consents_id_seq,
  email_verification_tokens_id_seq,
  password_reset_tokens_id_seq,
  sessions_id_seq,
  api_idempotency_keys_id_seq,
  classes_id_seq,
  class_members_id_seq,
  class_member_status_history_id_seq,
  class_invite_codes_id_seq,
  notices_id_seq,
  notice_reads_id_seq,
  supplies_id_seq,
  supply_checks_id_seq,
  schedules_id_seq,
  audit_logs_id_seq
  TO classhub_app;

-- Reset the non-HTTP runtime roles as well, so historical or accidental
-- grants cannot silently survive this hardening migration.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM classhub_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM classhub_worker;
GRANT SELECT, INSERT ON security_audit_logs TO classhub_worker;
GRANT USAGE ON SEQUENCE security_audit_logs_id_seq TO classhub_worker;

-- This role exists only in local provisioning. Deployed environments can omit
-- it entirely; the conditional block keeps the migration portable.
DO $local_admin_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM classhub_local_admin';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM classhub_local_admin';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON users TO classhub_local_admin';
    EXECUTE 'GRANT SELECT, INSERT ON user_consents TO classhub_local_admin';
    EXECUTE 'GRANT SELECT ON email_verification_tokens, password_reset_tokens, sessions, api_idempotency_keys, class_members TO classhub_local_admin';
    EXECUTE 'GRANT SELECT (id, email_normalized, status) ON operators TO classhub_local_admin';
    EXECUTE 'GRANT USAGE ON SEQUENCE users_id_seq, user_consents_id_seq TO classhub_local_admin';
  END IF;
END
$local_admin_grants$;

-- Down Migration

-- Least-privilege hardening is intentionally forward-only. Restoring the old
-- broad defaults during a rollback would reopen the P0 vulnerability. A code
-- compatibility rollback must instead use a reviewed forward ACL migration.
SELECT 1;
