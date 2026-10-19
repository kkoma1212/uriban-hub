-- Activate only after the corresponding isolated migration/ACL checks and operating approval.
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.social_identities TO 'classhub_app'@'%';
GRANT UPDATE (used_at) ON classhub_mariadb_phase1_dev.social_identities TO 'classhub_app'@'%';
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.social_oauth_flows TO 'classhub_app'@'%';
GRANT UPDATE (encrypted_payload, consumed_at) ON classhub_mariadb_phase1_dev.social_oauth_flows TO 'classhub_app'@'%';
