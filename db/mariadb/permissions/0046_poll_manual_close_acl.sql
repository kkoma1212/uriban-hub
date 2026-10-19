-- Activate together with app_poll_close_v1; leave the installation baseline intact.
GRANT UPDATE (closed_at, row_version)
  ON classhub_mariadb_phase1_dev.polls TO 'classhub_app'@'%';
