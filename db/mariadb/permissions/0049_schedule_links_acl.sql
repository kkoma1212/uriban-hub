-- Activate together with the schedule link module; leave the installation baseline intact.
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.schedule_notice_links TO 'classhub_app'@'%';
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.schedule_supply_links TO 'classhub_app'@'%';
