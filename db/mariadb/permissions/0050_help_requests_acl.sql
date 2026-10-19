-- Activate together with the help request module; leave the installation baseline intact.
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.help_requests TO 'classhub_app'@'%';
GRANT UPDATE (status, reply, closed_at) ON classhub_mariadb_phase1_dev.help_requests TO 'classhub_app'@'%';
