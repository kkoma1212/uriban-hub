-- T-HUB-64 phase-0007 immutable published content audience guards.
-- ISOLATED SYNTHETIC QA ONLY. Runtime privileges remain separate.

DELIMITER //

CREATE DEFINER=`classhub_routine`@`%` TRIGGER notices_audience_mode_immutable
BEFORE UPDATE ON notices
FOR EACH ROW
BEGIN
  IF NOT (BINARY NEW.audience_mode <=> BINARY OLD.audience_mode) THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30801,
          MESSAGE_TEXT = 'published content audience_mode is immutable';
  END IF;
END//

CREATE DEFINER=`classhub_routine`@`%` TRIGGER supplies_audience_mode_immutable
BEFORE UPDATE ON supplies
FOR EACH ROW
BEGIN
  IF NOT (BINARY NEW.audience_mode <=> BINARY OLD.audience_mode) THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30801,
          MESSAGE_TEXT = 'published content audience_mode is immutable';
  END IF;
END//

DELIMITER ;
