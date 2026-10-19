-- T-HUB-64 phase-0011 slot and assignment validation guards.
-- ISOLATED SYNTHETIC QA ONLY. The locked definer reads but never writes rows.

DELIMITER //

CREATE DEFINER=`classhub_routine`@`%` TRIGGER validate_seat_draw_slot_insert
BEFORE INSERT ON seat_draw_slots
FOR EACH ROW
BEGIN
  DECLARE target_rows SMALLINT DEFAULT NULL;
  DECLARE target_columns SMALLINT DEFAULT NULL;

  SELECT candidate.row_count, candidate.column_count
  INTO target_rows, target_columns
  FROM seat_draws AS candidate
  WHERE candidate.id = NEW.seat_draw_id AND candidate.class_id = NEW.class_id;

  IF target_rows IS NULL OR target_columns IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31101,
          MESSAGE_TEXT = 'seat draw does not belong to slot class';
  END IF;

  IF NEW.row_index > target_rows OR NEW.column_index > target_columns THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31102,
          MESSAGE_TEXT = 'seat slot is outside the draw dimensions';
  END IF;
END//

CREATE DEFINER=`classhub_routine`@`%` TRIGGER validate_seat_draw_slot_update
BEFORE UPDATE ON seat_draw_slots
FOR EACH ROW
BEGIN
  DECLARE target_rows SMALLINT DEFAULT NULL;
  DECLARE target_columns SMALLINT DEFAULT NULL;

  SELECT candidate.row_count, candidate.column_count
  INTO target_rows, target_columns
  FROM seat_draws AS candidate
  WHERE candidate.id = NEW.seat_draw_id AND candidate.class_id = NEW.class_id;

  IF target_rows IS NULL OR target_columns IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31101,
          MESSAGE_TEXT = 'seat draw does not belong to slot class';
  END IF;

  IF NEW.row_index > target_rows OR NEW.column_index > target_columns THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31102,
          MESSAGE_TEXT = 'seat slot is outside the draw dimensions';
  END IF;
END//

CREATE DEFINER=`classhub_routine`@`%` TRIGGER validate_seat_draw_assignment_insert
BEFORE INSERT ON seat_draw_assignments
FOR EACH ROW
BEGIN
  DECLARE target_usable BOOLEAN DEFAULT NULL;

  SELECT candidate.is_usable
  INTO target_usable
  FROM seat_draw_slots AS candidate
  WHERE candidate.id = NEW.seat_slot_id
    AND candidate.seat_draw_id = NEW.seat_draw_id
    AND candidate.class_id = NEW.class_id;

  IF target_usable IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31103,
          MESSAGE_TEXT = 'seat slot does not belong to assignment draw';
  END IF;

  IF target_usable IS NOT TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31104,
          MESSAGE_TEXT = 'student cannot be assigned to an unusable seat';
  END IF;
END//

CREATE DEFINER=`classhub_routine`@`%` TRIGGER validate_seat_draw_assignment_update
BEFORE UPDATE ON seat_draw_assignments
FOR EACH ROW
BEGIN
  DECLARE target_usable BOOLEAN DEFAULT NULL;

  SELECT candidate.is_usable
  INTO target_usable
  FROM seat_draw_slots AS candidate
  WHERE candidate.id = NEW.seat_slot_id
    AND candidate.seat_draw_id = NEW.seat_draw_id
    AND candidate.class_id = NEW.class_id;

  IF target_usable IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31103,
          MESSAGE_TEXT = 'seat slot does not belong to assignment draw';
  END IF;

  IF target_usable IS NOT TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31104,
          MESSAGE_TEXT = 'student cannot be assigned to an unusable seat';
  END IF;
END//

DELIMITER ;
