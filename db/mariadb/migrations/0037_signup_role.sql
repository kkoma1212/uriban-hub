-- Candidate follow-up for the active54 installation. No legacy-role inference.
USE classhub_mariadb_phase1_dev;
ALTER TABLE users
  ADD COLUMN signup_role VARCHAR(7) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT users_signup_role_check CHECK (signup_role IN ('student', 'teacher'));
GRANT INSERT (signup_role), UPDATE (signup_role)
  ON classhub_mariadb_phase1_dev.users TO 'classhub_app'@'%';
