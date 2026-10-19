-- T-HUB-62 phase-0002 invariant-core self-service membership routine draft.
-- Provisional target: MariaDB 11.4 LTS.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- The caller owns authentication, authorization, rate limits, cleanup, audit,
-- and retries in the same transaction. These routines lock the user first,
-- then the class and member rows in the governing PRD order,
-- revalidate the protected state, write one fixed transition plus one matching
-- history row, and return the database timestamp for caller-owned records.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE request_class_membership(
  IN p_class_id BIGINT,
  IN p_user_id BIGINT,
  IN p_invite_code VARCHAR(8),
  OUT out_member_id BIGINT,
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Create or reuse one student membership as pending'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE locked_user_verified_at DATETIME(6);
  DECLARE current_member_id BIGINT DEFAULT NULL;
  DECLARE teacher_profile_user_id BIGINT DEFAULT NULL;
  DECLARE locked_invite_id BIGINT DEFAULT NULL;
  DECLARE locked_invite_expires_at DATETIME(6);
  DECLARE locked_invite_revoked_at DATETIME(6);
  DECLARE existing_member_id BIGINT DEFAULT NULL;
  DECLARE existing_role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE existing_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'membership request requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at, email_verified_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at, locked_user_verified_at
    FROM users
    WHERE id = p_user_id
    FOR UPDATE;
  END;
  IF locked_user_id IS NULL
    OR locked_user_active = FALSE
    OR locked_user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30202,
          MESSAGE_TEXT = 'membership request account is not active';
  END IF;
  IF locked_user_verified_at IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30217,
          MESSAGE_TEXT = 'membership request email is not verified';
  END IF;

  -- PRD 6.3 explicitly serializes the user's cross-class current-membership
  -- fence before the target class. Every compliant user-owned membership path
  -- takes the same user row first.
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET current_member_id = NULL;
    SELECT id
    INTO current_member_id
    FROM class_members
    WHERE current_user_id = p_user_id
    FOR UPDATE;
  END;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET teacher_profile_user_id = NULL;
    SELECT user_id
    INTO teacher_profile_user_id
    FROM teacher_profiles
    WHERE user_id = p_user_id
    FOR UPDATE;
  END;
  IF teacher_profile_user_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30204,
          MESSAGE_TEXT = 'teacher account cannot request student membership';
  END IF;
  IF current_member_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30203,
          MESSAGE_TEXT = 'membership request account already has a current membership';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);

  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30201,
          MESSAGE_TEXT = 'membership request requires an active class';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_invite_id = NULL;
    SELECT id, expires_at, revoked_at
    INTO locked_invite_id, locked_invite_expires_at, locked_invite_revoked_at
    FROM class_invite_codes
    WHERE class_id = p_class_id
      AND BINARY code = BINARY p_invite_code
    ORDER BY id
    LIMIT 1
    FOR UPDATE;
  END;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET existing_member_id = NULL;
    SELECT id, role, status
    INTO existing_member_id, existing_role, existing_status
    FROM class_members
    WHERE class_id = p_class_id AND user_id = p_user_id
    LIMIT 1
    FOR UPDATE;
  END;

  SET out_occurred_at = UTC_TIMESTAMP(6);
  IF locked_invite_id IS NULL
    OR locked_invite_revoked_at IS NOT NULL
    OR locked_invite_expires_at <= out_occurred_at THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30205,
          MESSAGE_TEXT = 'membership request invite is not active';
  END IF;

  IF existing_member_id IS NULL THEN
    INSERT INTO class_members (
      class_id, user_id, role, status, status_changed_at, created_at, updated_at
    ) VALUES (
      p_class_id, p_user_id, 'student', 'pending',
      out_occurred_at, out_occurred_at, out_occurred_at
    );
    SET out_member_id = LAST_INSERT_ID();
    SET existing_status = NULL;
  ELSE
    IF BINARY existing_role = BINARY 'student'
      AND BINARY existing_status = BINARY 'removed' THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30216,
            MESSAGE_TEXT = 'membership request requires teacher rejoin allowance';
    END IF;
    IF BINARY existing_role <> BINARY 'student'
      OR BINARY existing_status NOT IN (
        BINARY 'rejected', BINARY 'canceled', BINARY 'left', BINARY 'rejoin_allowed'
      ) THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30206,
            MESSAGE_TEXT = 'membership request state is not reusable';
    END IF;

    UPDATE class_members
    SET status = 'pending',
        row_version = row_version + 1,
        status_changed_at = out_occurred_at,
        updated_at = out_occurred_at
    WHERE id = existing_member_id
      AND class_id = p_class_id
      AND BINARY status = BINARY existing_status;
    IF ROW_COUNT() <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30207,
            MESSAGE_TEXT = 'membership request compare-and-set failed';
    END IF;
    SET out_member_id = existing_member_id;
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    out_member_id, p_class_id, existing_status, 'pending',
    p_user_id, NULL, NULL, NULL, out_occurred_at
  );

  CALL assert_class_invariants(p_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE cancel_class_membership_request(
  IN p_class_id BIGINT,
  IN p_user_id BIGINT,
  IN p_member_id BIGINT,
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Move one own pending student membership to canceled'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE locked_member_id BIGINT DEFAULT NULL;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'membership cancellation requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at
    FROM users
    WHERE id = p_user_id
    FOR UPDATE;
  END;
  IF locked_user_id IS NULL OR locked_user_active = FALSE OR locked_user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30209,
          MESSAGE_TEXT = 'membership cancellation account is not active';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);

  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status NOT IN (BINARY 'active', BINARY 'suspended') THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30208,
          MESSAGE_TEXT = 'membership cancellation requires a live class';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_member_id = NULL;
    SELECT id
    INTO locked_member_id
    FROM class_members
    WHERE id = p_member_id
      AND class_id = p_class_id
      AND user_id = p_user_id
      AND BINARY role = BINARY 'student'
      AND BINARY status = BINARY 'pending'
    FOR UPDATE;
  END;
  IF locked_member_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30210,
          MESSAGE_TEXT = 'membership cancellation source state changed';
  END IF;

  SET out_occurred_at = UTC_TIMESTAMP(6);

  UPDATE class_members
  SET status = 'canceled',
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_member_id
    AND class_id = p_class_id
    AND BINARY status = BINARY 'pending';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30211,
          MESSAGE_TEXT = 'membership cancellation compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_member_id, p_class_id, 'pending', 'canceled',
    p_user_id, NULL, NULL, NULL, out_occurred_at
  );

  CALL assert_class_invariants(p_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE leave_class(
  IN p_class_id BIGINT,
  IN p_user_id BIGINT,
  IN p_member_id BIGINT,
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Move one own approved student membership to left'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE locked_member_id BIGINT DEFAULT NULL;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'membership leave requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at
    FROM users
    WHERE id = p_user_id
    FOR UPDATE;
  END;
  IF locked_user_id IS NULL OR locked_user_active = FALSE OR locked_user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30213,
          MESSAGE_TEXT = 'membership leave account is not active';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);

  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status NOT IN (BINARY 'active', BINARY 'suspended') THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30212,
          MESSAGE_TEXT = 'membership leave requires a live class';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_member_id = NULL;
    SELECT id
    INTO locked_member_id
    FROM class_members
    WHERE id = p_member_id
      AND class_id = p_class_id
      AND user_id = p_user_id
      AND BINARY role = BINARY 'student'
      AND BINARY status = BINARY 'approved'
    FOR UPDATE;
  END;
  IF locked_member_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30214,
          MESSAGE_TEXT = 'membership leave source state changed';
  END IF;

  SET out_occurred_at = UTC_TIMESTAMP(6);

  UPDATE class_members
  SET status = 'left',
      student_number = NULL,
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_member_id
    AND class_id = p_class_id
    AND BINARY status = BINARY 'approved';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30215,
          MESSAGE_TEXT = 'membership leave compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_member_id, p_class_id, 'approved', 'left',
    p_user_id, p_member_id, NULL, NULL, out_occurred_at
  );

  CALL assert_class_invariants(p_class_id);
END//

DELIMITER ;
