-- Isolated synthetic QA only. Source0031 tie-break immutability after creation.
DELIMITER //
CREATE DEFINER=`classhub_routine`@`%` TRIGGER elections_tie_break_immutable
BEFORE UPDATE ON elections
FOR EACH ROW
BEGIN
  IF NOT (BINARY NEW.tie_break <=> BINARY OLD.tie_break) THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 31501,
          MESSAGE_TEXT = 'election tie break rule cannot change after creation';
  END IF;
END//
DELIMITER ;
