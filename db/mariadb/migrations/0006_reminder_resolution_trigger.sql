-- T-HUB-64 phase-0006 one-way reminder resolution trigger.
-- ISOLATED SYNTHETIC QA ONLY. Runtime identities receive no privilege here.

DELIMITER //

CREATE DEFINER=`classhub_routine`@`%` TRIGGER in_app_reminder_recipients_resolution_guard
BEFORE UPDATE ON in_app_reminder_recipients
FOR EACH ROW
BEGIN
  IF NOT (NEW.resolved_at <=> OLD.resolved_at)
    AND NOT (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30701,
          MESSAGE_TEXT = 'in-app reminder resolution is one-way and cannot be cleared or changed';
  END IF;
END//

DELIMITER ;
