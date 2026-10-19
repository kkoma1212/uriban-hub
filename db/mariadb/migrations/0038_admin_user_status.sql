-- T-HUB-64 administrator user-status follow-up; isolated MariaDB candidate.
-- Requires the existing locked classhub_routine owner, phase-0002 invariant
-- helpers and its reviewed SELECT/UPDATE envelope. The companion permission
-- file grants only this procedure's EXECUTE; users.is_active stays protected.
-- Caller owns READ-COMMITTED transaction, administrator authorization, sessions
-- and operation audit. Any failure requires rolling back that entire transaction.
-- Preserve the caller's existing UTC application timestamp and PostgreSQL policy:
-- an approved teacher in an active class must be transferred before deactivation.
-- Suspended classes are not promoted to active and memberships are not changed.
-- PostgreSQL semantic source: enforce_user_teacher_invariants in source0001.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE set_admin_user_status(
  IN p_user_id BIGINT,
  IN p_is_active BOOLEAN,
  IN p_updated_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Change one account status inside the protected teacher-class boundary'
BEGIN
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE previous_active BOOLEAN;
  DECLARE user_deleted_at DATETIME(6);
  DECLARE teacher_class_id BIGINT;
  DECLARE teacher_classes_done BOOLEAN DEFAULT FALSE;
  DECLARE active_approved_teacher_count BIGINT DEFAULT 0;
  DECLARE teacher_class_cursor CURSOR FOR
    SELECT DISTINCT class_id
    FROM class_members FORCE INDEX (class_members_user_class_id_idx)
    WHERE user_id = p_user_id AND BINARY role = BINARY 'teacher'
    ORDER BY class_id;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET teacher_classes_done = TRUE;

  CALL assert_read_committed_session();
  IF p_user_id IS NULL OR p_user_id <= 0
    OR p_is_active IS NULL OR p_is_active NOT IN (FALSE, TRUE)
    OR p_updated_at IS NULL OR YEAR(p_updated_at) < 1000 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 32001,
          MESSAGE_TEXT = 'administrator user status input is invalid';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at
    INTO locked_user_id, previous_active, user_deleted_at
    FROM users WHERE id = p_user_id FOR UPDATE;
  END;
  IF locked_user_id IS NULL OR user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 32002,
          MESSAGE_TEXT = 'administrator user status target does not exist';
  END IF;
  IF previous_active = p_is_active THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 32003,
          MESSAGE_TEXT = 'administrator user status is unchanged';
  END IF;

  -- All protected teacher-membership writers lock this user before classes.
  -- Discovery after the user lock therefore has a stable teacher-class set;
  -- it takes no member locks before the ascending class serialization fences.
  SET teacher_classes_done = FALSE;
  OPEN teacher_class_cursor;
  class_lock_loop: LOOP
    FETCH teacher_class_cursor INTO teacher_class_id;
    IF teacher_classes_done THEN LEAVE class_lock_loop; END IF;
    CALL lock_class_invariant_boundary(teacher_class_id);
  END LOOP;
  CLOSE teacher_class_cursor;

  IF p_is_active = FALSE THEN
    SELECT COUNT(member.id) INTO active_approved_teacher_count
    FROM class_members AS member
    INNER JOIN classes AS target_class ON target_class.id = member.class_id
    WHERE member.user_id = p_user_id
      AND BINARY member.role = BINARY 'teacher'
      AND BINARY member.status = BINARY 'approved'
      AND BINARY target_class.status = BINARY 'active';
    IF active_approved_teacher_count <> 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 32004,
            MESSAGE_TEXT = 'administrator user status requires teacher transfer';
    END IF;
  END IF;

  UPDATE users
  SET is_active = p_is_active, updated_at = p_updated_at
  WHERE id = p_user_id AND is_active = previous_active AND deleted_at IS NULL;
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 32005,
          MESSAGE_TEXT = 'administrator user status compare-and-set failed';
  END IF;

  -- Match the PG user trigger: check every teacher class, including historical
  -- transferred/archived memberships. The routine never commits caller work.
  SET teacher_classes_done = FALSE;
  OPEN teacher_class_cursor;
  class_assertion_loop: LOOP
    FETCH teacher_class_cursor INTO teacher_class_id;
    IF teacher_classes_done THEN LEAVE class_assertion_loop; END IF;
    CALL assert_class_invariants(teacher_class_id);
  END LOOP;
  CLOSE teacher_class_cursor;
END//

DELIMITER ;
