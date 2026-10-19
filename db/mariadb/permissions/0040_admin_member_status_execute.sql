-- Isolated candidate; requires migrations/0040_admin_member_status.sql.
-- Phase 0024 already grants the locked owner SELECT of the new actor column.
-- Its old INSERT envelope predates that column, so extend only that one INSERT.
-- Runtime identities receive no class_members/status-history table write grant.
GRANT INSERT (actor_admin_account_id)
  ON classhub_mariadb_phase1_dev.class_member_status_history
  TO 'classhub_routine'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.set_admin_member_status
  TO 'classhub_routine'@'%';
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.set_admin_member_status
  TO 'classhub_app'@'%';
