-- Phase 0024 source0045 actor expansion; original role/status validation stays intact.
-- Locked definer, isolated synthetic QA only. Replace the existing trigger, not its original file.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;
DELIMITER //
CREATE OR REPLACE DEFINER = 'classhub_routine'@'%' TRIGGER class_member_status_history_validate
BEFORE INSERT ON class_member_status_history
FOR EACH ROW
BEGIN
  DECLARE member_role VARCHAR(16);

  IF NOT (
    (NEW.actor_operator_id IS NOT NULL AND NEW.actor_admin_account_id IS NULL
      AND NEW.actor_user_id IS NULL AND NEW.actor_member_id IS NULL)
    OR (NEW.actor_operator_id IS NULL AND NEW.actor_admin_account_id IS NULL
      AND NEW.actor_user_id IS NOT NULL)
    OR (NEW.actor_operator_id IS NULL AND NEW.actor_admin_account_id IS NOT NULL
      AND NEW.actor_user_id IS NULL AND NEW.actor_member_id IS NULL)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'status history requires one supported actor type';
  END IF;

  SET member_role = (
    SELECT role
    FROM class_members
    WHERE id = NEW.member_id AND class_id = NEW.class_id
  );

  IF member_role IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'status history references an unknown class member';
  ELSEIF BINARY member_role = BINARY 'teacher' THEN
    IF NOT (
      BINARY NEW.to_status IN (
        BINARY 'approved', BINARY 'transferred', BINARY 'archived'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid teacher to_status in class member history';
    END IF;

    IF NEW.from_status IS NULL THEN
      IF BINARY NEW.to_status <> BINARY 'approved' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'teacher history must start at approved';
      END IF;
    ELSEIF NOT (
      BINARY NEW.from_status IN (
        BINARY 'approved', BINARY 'transferred', BINARY 'archived'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid teacher from_status in class member history';
    END IF;
  ELSEIF BINARY member_role = BINARY 'student' THEN
    IF NOT (
      BINARY NEW.to_status IN (
        BINARY 'pending', BINARY 'approved', BINARY 'rejected', BINARY 'canceled',
        BINARY 'left', BINARY 'removed', BINARY 'rejoin_allowed', BINARY 'archived',
        BINARY 'account_deleted'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid student to_status in class member history';
    END IF;

    IF NEW.from_status IS NULL THEN
      IF BINARY NEW.to_status <> BINARY 'pending' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'student history must start at pending';
      END IF;
    ELSEIF NOT (
      BINARY NEW.from_status IN (
        BINARY 'pending', BINARY 'approved', BINARY 'rejected', BINARY 'canceled',
        BINARY 'left', BINARY 'removed', BINARY 'rejoin_allowed', BINARY 'archived',
        BINARY 'account_deleted'
      )
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'invalid student from_status in class member history';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'status history references a member with an unknown role';
  END IF;
END//

DELIMITER ;
