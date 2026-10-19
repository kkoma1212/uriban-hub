-- T-HUB-64 phase-0011 exact locked validation-trigger envelope.
-- ISOLATED SYNTHETIC QA ONLY. Reuse the existing locked/passwordless definer.
-- Include only parent lookup columns and the NEW fields each guard actually reads.

GRANT SELECT (id, class_id, row_count, column_count)
  ON classhub_mariadb_phase1_dev.seat_draws
  TO 'classhub_routine'@'%';
GRANT SELECT (id, seat_draw_id, class_id, row_index, column_index, is_usable)
  ON classhub_mariadb_phase1_dev.seat_draw_slots
  TO 'classhub_routine'@'%';
GRANT SELECT (seat_slot_id, seat_draw_id, class_id)
  ON classhub_mariadb_phase1_dev.seat_draw_assignments
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.seat_draw_slots
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.seat_draw_assignments
  TO 'classhub_routine'@'%';
