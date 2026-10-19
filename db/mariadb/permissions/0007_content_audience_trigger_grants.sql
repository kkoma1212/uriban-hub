-- T-HUB-64 phase-0007 locked audience-trigger envelope.
-- ISOLATED SYNTHETIC QA ONLY. Reuse the existing locked/passwordless definer.
-- The guards read OLD/NEW audience_mode without assigning NEW or writing rows.

GRANT SELECT (audience_mode)
  ON classhub_mariadb_phase1_dev.notices
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.notices
  TO 'classhub_routine'@'%';
GRANT SELECT (audience_mode)
  ON classhub_mariadb_phase1_dev.supplies
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.supplies
  TO 'classhub_routine'@'%';
