-- T-HUB-64 phase-0006 locked reminder-trigger envelope.
-- ISOLATED SYNTHETIC QA ONLY. The existing locked/passwordless definer is reused.
-- Reading OLD/NEW requires SELECT; this trigger does not assign NEW or update rows.

GRANT SELECT (resolved_at)
  ON classhub_mariadb_phase1_dev.in_app_reminder_recipients
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.in_app_reminder_recipients
  TO 'classhub_routine'@'%';
