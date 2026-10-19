-- Activate together with the *_polledit_v1 app profiles; leave the installation baseline intact.
-- Options are replaced through the existing DELETE/INSERT on poll_options while no vote exists.
GRANT UPDATE (title, description, option_count, closes_at)
  ON classhub_mariadb_phase1_dev.polls TO 'classhub_app'@'%';
