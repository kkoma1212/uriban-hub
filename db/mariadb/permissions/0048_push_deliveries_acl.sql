-- Activate together with the web push delivery queue; leave the installation baseline intact.
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.push_deliveries TO 'classhub_app'@'%';
GRANT UPDATE (status, accepted_count, failed_count, removed_count, completed_at)
  ON classhub_mariadb_phase1_dev.push_deliveries TO 'classhub_app'@'%';
