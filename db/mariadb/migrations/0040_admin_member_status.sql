-- Administrator-actor membership transition, isolated MariaDB candidate.
-- Requires phase-0002 protected class routines and the phase-0024 administrator
-- actor column/history trigger. Caller owns administrator authorization, audit,
-- downstream cleanup and the complete READ-COMMITTED transaction/rollback.
-- No teacher identity is invented and no application status/history DML is granted.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE set_admin_member_status(
  IN p_class_id BIGINT,
  IN p_target_user_id BIGINT,
  IN p_target_member_id BIGINT,
  IN p_next_status VARCHAR(32),
  IN p_reason LONGTEXT,
  IN p_admin_account_id BIGINT,
  IN p_changed_at DATETIME(6),
  OUT out_history_id BIGINT
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Change one student membership with an explicit administrator actor'
BEGIN
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_member_id BIGINT DEFAULT NULL;
  DECLARE locked_member_role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_member_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE expected_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE transition_reason LONGTEXT;
  DECLARE changed_member_count INT DEFAULT 0;

  SET out_history_id = NULL;
  CALL assert_read_committed_session();
  IF p_class_id IS NULL OR p_class_id <= 0
    OR p_target_user_id IS NULL OR p_target_user_id <= 0
    OR p_target_member_id IS NULL OR p_target_member_id <= 0
    OR p_admin_account_id IS NULL OR p_admin_account_id <= 0
    OR p_changed_at IS NULL OR YEAR(p_changed_at) < 1000 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32101,
      MESSAGE_TEXT = 'administrator member transition input is invalid';
  END IF;
  SET expected_status = CASE BINARY p_next_status
    WHEN BINARY 'approved' THEN 'pending'
    WHEN BINARY 'rejected' THEN 'pending'
    WHEN BINARY 'removed' THEN 'approved'
    WHEN BINARY 'rejoin_allowed' THEN 'removed'
    ELSE NULL
  END;
  IF expected_status IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32104,
      MESSAGE_TEXT = 'administrator member status transition is invalid';
  END IF;
  SET transition_reason = NULLIF(TRIM(p_reason), '');
  IF (BINARY p_next_status <> BINARY 'approved' AND transition_reason IS NULL)
    OR CHAR_LENGTH(transition_reason) > 300 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32105,
      MESSAGE_TEXT = 'administrator member transition reason is required or invalid';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at
    FROM users WHERE id = p_target_user_id FOR UPDATE;
  END;
  IF locked_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32102,
      MESSAGE_TEXT = 'administrator member target was not found';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);
  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32103,
      MESSAGE_TEXT = 'administrator member class is not active';
  END IF;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_member_id = NULL;
    SELECT id, role, status
    INTO locked_member_id, locked_member_role, locked_member_status
    FROM class_members
    WHERE id = p_target_member_id AND class_id = p_class_id AND user_id = p_target_user_id
    FOR UPDATE;
  END;
  IF locked_member_id IS NULL OR BINARY locked_member_role <> BINARY 'student' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32102,
      MESSAGE_TEXT = 'administrator member target was not found';
  END IF;
  IF BINARY locked_member_status <> BINARY expected_status THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32104,
      MESSAGE_TEXT = 'administrator member status transition is invalid';
  END IF;
  -- Match the existing administrator policy: inactive/deleted users cannot be
  -- approved, but rejecting/removing/rejoin permission do not require activity.
  IF BINARY p_next_status = BINARY 'approved'
    AND (locked_user_active = FALSE OR locked_user_deleted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32106,
      MESSAGE_TEXT = 'administrator member account is inactive';
  END IF;

  IF BINARY p_next_status = BINARY 'removed' THEN
    UPDATE class_members
    SET student_number = NULL, status = p_next_status, row_version = row_version + 1,
        status_changed_at = p_changed_at, updated_at = p_changed_at
    WHERE id = p_target_member_id AND class_id = p_class_id AND user_id = p_target_user_id
      AND BINARY role = BINARY 'student' AND BINARY status = BINARY expected_status;
    SET changed_member_count = ROW_COUNT();
  ELSE
    UPDATE class_members
    SET status = p_next_status, row_version = row_version + 1,
        status_changed_at = p_changed_at, updated_at = p_changed_at
    WHERE id = p_target_member_id AND class_id = p_class_id AND user_id = p_target_user_id
      AND BINARY role = BINARY 'student' AND BINARY status = BINARY expected_status;
    SET changed_member_count = ROW_COUNT();
  END IF;
  IF changed_member_count <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 32107,
      MESSAGE_TEXT = 'administrator member compare-and-set failed';
  END IF;

  -- Preserve the schema's creation-time default; OUT binds the exact inserted
  -- history row to the caller's verification, independently of its timestamp.
  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status, actor_admin_account_id,
    actor_user_id, actor_member_id, actor_operator_id, reason
  ) VALUES (
    p_target_member_id, p_class_id, expected_status, p_next_status, p_admin_account_id,
    NULL, NULL, NULL, transition_reason
  );
  SET out_history_id = LAST_INSERT_ID();
  CALL assert_class_invariants(p_class_id);
END//

DELIMITER ;
