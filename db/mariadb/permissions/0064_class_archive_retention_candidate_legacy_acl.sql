-- Isolated synthetic review candidate only. No production activation.
-- Apply after the shell/schema candidate and existing admin-retention ACL; account host/database must be reviewed.
-- Supplemental only when all eleven legacy layout/draw/duty tables actually exist.
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.seat_draw_assignments TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.seat_draw_slots TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.seat_draws TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.team_draw_assignments TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.team_draw_groups TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.team_draws TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.duty_assignments TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.duty_rosters TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.class_duty_roles TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.layout_draft_autosaves TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.classroom_layout_templates TO 'classhub_retention'@'%';
