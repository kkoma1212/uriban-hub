-- T-HUB-62 phase-0002 invariant-core operator transfer routine draft.
-- Provisional target: MariaDB 11.4 LTS.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- Operator authentication and both audit logs remain caller-owned in the same
-- transaction. The routine receives the preliminarily observed outgoing ids,
-- then revalidates them under users -> class -> memberships -> profile locks.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE transfer_class_teacher(
  IN p_operator_id BIGINT,
  IN p_class_id BIGINT,
  IN p_outgoing_user_id BIGINT,
  IN p_outgoing_member_id BIGINT,
  IN p_incoming_user_id BIGINT,
  IN p_reason VARCHAR(300),
  OUT out_incoming_member_id BIGINT,
  OUT out_incoming_from_status VARCHAR(32),
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Transfer one live class from its approved teacher to another teacher'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE outgoing_user_is_present BOOLEAN DEFAULT FALSE;
  DECLARE incoming_user_is_present BOOLEAN DEFAULT FALSE;
  DECLARE incoming_user_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE outgoing_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE incoming_member_is_absent BOOLEAN DEFAULT TRUE;
  DECLARE incoming_current_member_id BIGINT DEFAULT NULL;
  DECLARE profile_user_id BIGINT DEFAULT NULL;
  DECLARE profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE profile_temporary BOOLEAN DEFAULT TRUE;
  DECLARE transition_reason VARCHAR(300);

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'teacher transfer requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();
  IF p_outgoing_user_id = p_incoming_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30502,
          MESSAGE_TEXT = 'teacher transfer requires distinct users';
  END IF;

  BEGIN
    DECLARE users_done BOOLEAN DEFAULT FALSE;
    DECLARE current_user_id BIGINT;
    DECLARE current_user_active BOOLEAN;
    DECLARE current_user_deleted_at DATETIME(6);
    DECLARE user_cursor CURSOR FOR
      SELECT id, is_active, deleted_at
      FROM users FORCE INDEX (PRIMARY)
      WHERE id IN (p_outgoing_user_id, p_incoming_user_id)
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET users_done = TRUE;

    OPEN user_cursor;
    user_lock_loop: LOOP
      FETCH user_cursor INTO current_user_id, current_user_active, current_user_deleted_at;
      IF users_done THEN
        LEAVE user_lock_loop;
      END IF;
      IF current_user_id = p_outgoing_user_id THEN
        SET outgoing_user_is_present = TRUE;
      END IF;
      IF current_user_id = p_incoming_user_id THEN
        SET incoming_user_is_present = TRUE;
        IF current_user_active = TRUE AND current_user_deleted_at IS NULL THEN
          SET incoming_user_is_valid = TRUE;
        END IF;
      END IF;
    END LOOP;
    CLOSE user_cursor;
  END;
  IF outgoing_user_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30503,
          MESSAGE_TEXT = 'teacher transfer outgoing user does not exist';
  END IF;
  IF incoming_user_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30510,
          MESSAGE_TEXT = 'teacher transfer incoming user does not exist';
  END IF;
  IF incoming_user_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30511,
          MESSAGE_TEXT = 'teacher transfer incoming user is not active';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);

  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status NOT IN (BINARY 'active', BINARY 'suspended') THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30501,
          MESSAGE_TEXT = 'teacher transfer requires a live class';
  END IF;

  SET out_incoming_member_id = NULL;
  SET out_incoming_from_status = NULL;
  BEGIN
    DECLARE members_done BOOLEAN DEFAULT FALSE;
    DECLARE current_member_id BIGINT;
    DECLARE current_member_user_id BIGINT;
    DECLARE current_member_role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE current_member_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE member_cursor CURSOR FOR
      SELECT id, user_id, role, status
      FROM class_members
      WHERE class_id = p_class_id
        AND (id = p_outgoing_member_id OR user_id = p_incoming_user_id)
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET members_done = TRUE;

    OPEN member_cursor;
    member_lock_loop: LOOP
      FETCH member_cursor
      INTO current_member_id, current_member_user_id, current_member_role, current_member_status;
      IF members_done THEN
        LEAVE member_lock_loop;
      END IF;

      IF current_member_id = p_outgoing_member_id
        AND current_member_user_id = p_outgoing_user_id
        AND BINARY current_member_role = BINARY 'teacher'
        AND BINARY current_member_status = BINARY 'approved' THEN
        SET outgoing_member_is_valid = TRUE;
      END IF;

      IF current_member_user_id = p_incoming_user_id THEN
        SET incoming_member_is_absent = FALSE;
        SET out_incoming_member_id = current_member_id;
        SET out_incoming_from_status = current_member_status;
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;
  IF outgoing_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30504,
          MESSAGE_TEXT = 'teacher transfer outgoing membership changed';
  END IF;
  IF incoming_member_is_absent = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30505,
          MESSAGE_TEXT = 'teacher transfer requires no prior membership in the target class';
  END IF;

  -- The incoming user row serializes all compliant current-membership writes.
  -- This current locking read rejects membership in another class.
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET incoming_current_member_id = NULL;
    SELECT id
    INTO incoming_current_member_id
    FROM class_members
    WHERE current_user_id = p_incoming_user_id
    FOR UPDATE;
  END;
  IF incoming_current_member_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30506,
          MESSAGE_TEXT = 'teacher transfer incoming user has a current membership';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO profile_user_id, profile_status, profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_incoming_user_id
    FOR UPDATE;
  END;
  IF profile_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30507,
          MESSAGE_TEXT = 'teacher transfer incoming teacher profile does not exist';
  END IF;
  IF BINARY profile_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30512,
          MESSAGE_TEXT = 'teacher transfer incoming teacher profile is not active';
  END IF;
  IF profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30513,
          MESSAGE_TEXT = 'teacher transfer incoming temporary password is not changed';
  END IF;

  SET transition_reason = NULLIF(TRIM(p_reason), '');
  SET out_occurred_at = UTC_TIMESTAMP(6);

  UPDATE class_members
  SET status = 'transferred',
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_outgoing_member_id
    AND class_id = p_class_id
    AND user_id = p_outgoing_user_id
    AND BINARY role = BINARY 'teacher'
    AND BINARY status = BINARY 'approved';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30508,
          MESSAGE_TEXT = 'teacher transfer outgoing compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_outgoing_member_id, p_class_id, 'approved', 'transferred',
    NULL, NULL, p_operator_id, transition_reason, out_occurred_at
  );

  INSERT INTO class_members (
    class_id, user_id, role, status, status_changed_at, created_at, updated_at
  ) VALUES (
    p_class_id, p_incoming_user_id, 'teacher', 'approved',
    out_occurred_at, out_occurred_at, out_occurred_at
  );
  SET out_incoming_member_id = LAST_INSERT_ID();
  SET out_incoming_from_status = NULL;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    out_incoming_member_id, p_class_id, out_incoming_from_status, 'approved',
    NULL, NULL, p_operator_id, transition_reason, out_occurred_at
  );

  IF BINARY locked_class_status = BINARY 'suspended' THEN
    UPDATE classes
    SET status = 'active',
        suspended_reason = NULL,
        suspended_at = NULL,
        suspended_by_operator_id = NULL,
        row_version = row_version + 1,
        updated_at = out_occurred_at
    WHERE id = p_class_id AND BINARY status = BINARY 'suspended';
    IF ROW_COUNT() <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30509,
            MESSAGE_TEXT = 'teacher transfer class reactivation compare-and-set failed';
    END IF;
  END IF;

  CALL assert_class_invariants(p_class_id);
END//

DELIMITER ;
