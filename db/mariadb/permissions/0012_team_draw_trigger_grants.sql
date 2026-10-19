-- T-HUB-64 phase-0012 exact locked validation-trigger envelope.
-- ISOLATED SYNTHETIC QA ONLY. Reuse the existing locked/passwordless definer.
-- Include only parent lookup columns and the NEW fields each guard actually reads.

GRANT SELECT (id, class_id, group_count)
  ON classhub_mariadb_phase1_dev.team_draws
  TO 'classhub_routine'@'%';
GRANT SELECT (team_draw_id, class_id, group_index)
  ON classhub_mariadb_phase1_dev.team_draw_groups
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.team_draw_groups
  TO 'classhub_routine'@'%';
