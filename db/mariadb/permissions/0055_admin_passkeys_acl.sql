-- Prepared only. Exact app_admin_passkeys_v1 profile; approval required.
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.admin_passkeys TO 'classhub_app'@'%';
GRANT UPDATE (signature_counter, backed_up, used_at, revoked_at) ON classhub_mariadb_phase1_dev.admin_passkeys TO 'classhub_app'@'%';
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.admin_recovery_codes TO 'classhub_app'@'%';
GRANT UPDATE (used_at, revoked_at) ON classhub_mariadb_phase1_dev.admin_recovery_codes TO 'classhub_app'@'%';
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.admin_webauthn_challenges TO 'classhub_app'@'%';
GRANT UPDATE (consumed_at) ON classhub_mariadb_phase1_dev.admin_webauthn_challenges TO 'classhub_app'@'%';
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.admin_mfa_stepups TO 'classhub_app'@'%';
GRANT UPDATE (method, verified_at) ON classhub_mariadb_phase1_dev.admin_mfa_stepups TO 'classhub_app'@'%';
GRANT DELETE ON classhub_mariadb_phase1_dev.admin_mfa_stepups TO 'classhub_app'@'%';
