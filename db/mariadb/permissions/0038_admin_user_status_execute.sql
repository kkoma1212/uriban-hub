-- Install after migrations/0038_admin_user_status.sql in the isolated MariaDB
-- candidate. The locked owner already has the required users/class read/write
-- and internal-helper privileges from phase 0002. Do not widen those grants.
-- The application may invoke only the protected transition, never direct
-- users.is_active UPDATE or the low-level class invariant helpers.
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.set_admin_user_status
  TO 'classhub_routine'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.set_admin_user_status
  TO 'classhub_app'@'%';
