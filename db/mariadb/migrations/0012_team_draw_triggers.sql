-- T-HUB-64 phase-0012 team-group validation guards.
-- ISOLATED SYNTHETIC QA ONLY. The locked definer reads but never writes rows.

DELIMITER //

CREATE DEFINER=`classhub_routine`@`%` TRIGGER validate_team_draw_group_insert
BEFORE INSERT ON team_draw_groups
FOR EACH ROW
BEGIN
  DECLARE target_group_count SMALLINT DEFAULT NULL;

  SELECT candidate.group_count
  INTO target_group_count
  FROM team_draws AS candidate
  WHERE candidate.id = NEW.team_draw_id AND candidate.class_id = NEW.class_id;

  IF target_group_count IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31201,
          MESSAGE_TEXT = 'team draw does not belong to group class';
  END IF;

  IF NEW.group_index > target_group_count THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31202,
          MESSAGE_TEXT = 'team group index exceeds draw group count';
  END IF;
END//

CREATE DEFINER=`classhub_routine`@`%` TRIGGER validate_team_draw_group_update
BEFORE UPDATE ON team_draw_groups
FOR EACH ROW
BEGIN
  DECLARE target_group_count SMALLINT DEFAULT NULL;

  SELECT candidate.group_count
  INTO target_group_count
  FROM team_draws AS candidate
  WHERE candidate.id = NEW.team_draw_id AND candidate.class_id = NEW.class_id;

  IF target_group_count IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31201,
          MESSAGE_TEXT = 'team draw does not belong to group class';
  END IF;

  IF NEW.group_index > target_group_count THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31202,
          MESSAGE_TEXT = 'team group index exceeds draw group count';
  END IF;
END//

DELIMITER ;
