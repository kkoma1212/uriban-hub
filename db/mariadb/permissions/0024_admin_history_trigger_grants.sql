-- Isolated synthetic QA: one additional NEW column read for the existing locked definer.
GRANT SELECT (actor_admin_account_id)
  ON classhub_mariadb_phase1_dev.class_member_status_history
  TO 'classhub_routine'@'%';
