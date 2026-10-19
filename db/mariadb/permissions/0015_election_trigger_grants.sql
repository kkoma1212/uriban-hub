-- Isolated synthetic QA only. Reuse the existing locked/passwordless definer.
-- Only OLD/NEW tie_break is read; no row is written by the guard.
GRANT SELECT (tie_break)
  ON classhub_mariadb_phase1_dev.elections
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.elections
  TO 'classhub_routine'@'%';
