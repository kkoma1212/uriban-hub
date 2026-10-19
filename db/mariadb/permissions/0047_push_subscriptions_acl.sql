-- Activate together with the web push module; leave the installation baseline intact.
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.push_subscriptions TO 'classhub_app'@'%';
GRANT UPDATE (user_id, p256dh, auth_secret, updated_at)
  ON classhub_mariadb_phase1_dev.push_subscriptions TO 'classhub_app'@'%';
