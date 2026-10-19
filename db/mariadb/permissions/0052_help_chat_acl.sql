-- Activate together with the help chat module; leave the installation baseline intact.
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.help_request_messages TO 'classhub_app'@'%';
