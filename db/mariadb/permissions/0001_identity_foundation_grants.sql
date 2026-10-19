-- Development-only phase-0001 least-privilege grants.
-- Accounts are created by the isolated MariaDB dev bootstrap. No passwords live in this file.

GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.user_consents
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.email_verification_tokens
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.password_reset_tokens
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE
  ON classhub_mariadb_phase1_dev.sessions
  TO 'classhub_app'@'%';
GRANT SELECT, INSERT, DELETE
  ON classhub_mariadb_phase1_dev.api_idempotency_keys
  TO 'classhub_app'@'%';

GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.api_idempotency_keys
  TO 'classhub_retention'@'%';
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.sessions
  TO 'classhub_retention'@'%';
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.email_verification_tokens
  TO 'classhub_retention'@'%';
GRANT SELECT, DELETE
  ON classhub_mariadb_phase1_dev.password_reset_tokens
  TO 'classhub_retention'@'%';

-- classhub_worker and classhub_operator intentionally receive no phase-0001 table privilege.
-- MariaDB has no PostgreSQL sequence privilege counterpart for AUTO_INCREMENT.
