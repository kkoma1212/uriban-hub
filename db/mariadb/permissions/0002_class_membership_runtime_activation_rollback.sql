-- T-HUB-62 phase-0002 fail-closed runtime ACL reconcile draft.
--
-- DO NOT APPLY THIS FILE YET.
--
-- MariaDB DCL is not a caller transaction. This reconcile therefore starts by
-- clearing every privilege from the four runtime identities in one statement,
-- then rebuilds only the safe phase-0001 envelope. A failure after the REVOKE
-- is an availability failure, not an invariant bypass. The phase-0001 broad
-- users INSERT/UPDATE grant is deliberately never restored because phase-0002
-- schema/data may remain. Phase-0002 functions stay fail-closed until a fresh,
-- fully verified activation.
--
-- Preconditions: a security administrator has captured and matched the exact
-- before-state, confirmed these four accounts have no roles or out-of-band
-- grants, and passed every partial-activation recovery cut point on MariaDB
-- 11.4. This phase-scoped file must not run after later-phase runtime grants are
-- introduced; regenerate the complete desired-state reconcile instead. This
-- file does not drop routines, tables, accounts, or data.
-- Before the first statement, keep writes quiesced, prove zero active runtime
-- transactions, and drain all four identities' connections. Resume only through
-- fresh connections after the safe grant fingerprint and probes pass.

REVOKE ALL PRIVILEGES, GRANT OPTION
  FROM 'classhub_app'@'%',
       'classhub_operator'@'%',
       'classhub_retention'@'%',
       'classhub_worker'@'%';

GRANT SELECT
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_app'@'%';
GRANT INSERT (email_normalized, display_name, password_hash)
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_app'@'%';
GRANT UPDATE (
    display_name,
    email_verified_at,
    failed_login_attempts,
    locked_until,
    password_hash,
    password_last_changed_at,
    updated_at
  )
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

-- classhub_operator and classhub_worker intentionally keep only USAGE.
