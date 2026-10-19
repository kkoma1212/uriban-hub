-- T-HUB-64 phase-0004 audit actor/class validation trigger.
-- ISOLATED SYNTHETIC QA ONLY. Runtime identities receive no privilege here.

DELIMITER //

CREATE DEFINER=`classhub_routine`@`%` TRIGGER audit_logs_actor_class_validate
BEFORE INSERT ON audit_logs
FOR EACH ROW
BEGIN
  IF NEW.actor_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM class_members
    WHERE id = NEW.actor_member_id AND class_id = NEW.class_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30601,
          MESSAGE_TEXT = 'audit actor member does not belong to audit class';
  END IF;
END//

DELIMITER ;
