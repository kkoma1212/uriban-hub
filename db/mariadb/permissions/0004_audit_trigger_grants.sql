-- T-HUB-64 phase-0004 locked audit-trigger envelope.
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
-- The phase-0002 locked/passwordless classhub_routine definer must already exist.

GRANT SELECT (class_id, actor_member_id)
  ON classhub_mariadb_phase1_dev.audit_logs
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.audit_logs
  TO 'classhub_routine'@'%';
