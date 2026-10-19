-- T-HUB-62 phase-0002 invariant-core teacher membership-admin routine draft.
-- Provisional target: MariaDB 11.4 LTS.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- Each routine locks users, class, memberships, and the actor teacher profile
-- in one order before its first write. Caller-owned authentication, audit,
-- downstream cleanup, and retry logic must share the same transaction.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE approve_class_member(
  IN p_class_id BIGINT,
  IN p_actor_user_id BIGINT,
  IN p_actor_member_id BIGINT,
  IN p_target_user_id BIGINT,
  IN p_target_member_id BIGINT,
  IN p_display_name_in_class VARCHAR(20),
  IN p_student_number INT,
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Approve one pending student membership'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE actor_user_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_user_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE actor_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_present BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE profile_user_id BIGINT DEFAULT NULL;
  DECLARE profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE profile_temporary BOOLEAN DEFAULT TRUE;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'member approval requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();
  IF p_actor_user_id = p_target_user_id OR p_actor_member_id = p_target_member_id THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30302,
          MESSAGE_TEXT = 'member approval actor and target must be distinct';
  END IF;

  BEGIN
    DECLARE users_done BOOLEAN DEFAULT FALSE;
    DECLARE current_user_id BIGINT;
    DECLARE current_user_active BOOLEAN;
    DECLARE current_user_deleted_at DATETIME(6);
    DECLARE user_cursor CURSOR FOR
      SELECT id, is_active, deleted_at
      FROM users FORCE INDEX (PRIMARY)
      WHERE id IN (p_actor_user_id, p_target_user_id)
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET users_done = TRUE;

    OPEN user_cursor;
    user_lock_loop: LOOP
      FETCH user_cursor INTO current_user_id, current_user_active, current_user_deleted_at;
      IF users_done THEN
        LEAVE user_lock_loop;
      END IF;
      IF current_user_id = p_actor_user_id
        AND current_user_active = TRUE
        AND current_user_deleted_at IS NULL THEN
        SET actor_user_is_valid = TRUE;
      END IF;
      IF current_user_id = p_target_user_id
        AND current_user_active = TRUE
        AND current_user_deleted_at IS NULL THEN
        SET target_user_is_valid = TRUE;
      END IF;
    END LOOP;
    CLOSE user_cursor;
  END;
  IF target_user_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30325,
          MESSAGE_TEXT = 'member approval target account is not eligible';
  END IF;
  IF actor_user_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30303,
          MESSAGE_TEXT = 'member approval actor account is not eligible';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);
  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30328,
          MESSAGE_TEXT = 'member approval target class is suspended';
  END IF;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30301,
          MESSAGE_TEXT = 'member approval target class is not available';
  END IF;
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
        AND id IN (p_actor_member_id, p_target_member_id)
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
      IF current_member_id = p_actor_member_id
        AND current_member_user_id = p_actor_user_id
        AND BINARY current_member_role = BINARY 'teacher'
        AND BINARY current_member_status = BINARY 'approved' THEN
        SET actor_member_is_valid = TRUE;
      END IF;
      IF current_member_id = p_target_member_id
        AND current_member_user_id = p_target_user_id
        AND BINARY current_member_role = BINARY 'student' THEN
        SET target_member_is_present = TRUE;
        IF BINARY current_member_status = BINARY 'pending' THEN
          SET target_member_is_valid = TRUE;
        END IF;
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;
  IF actor_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30304,
          MESSAGE_TEXT = 'member approval actor membership is not eligible';
  END IF;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO profile_user_id, profile_status, profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF profile_user_id IS NULL
    OR BINARY profile_status <> BINARY 'active'
    OR profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30305,
          MESSAGE_TEXT = 'member approval actor teacher profile is not eligible';
  END IF;
  IF target_member_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30326,
          MESSAGE_TEXT = 'member approval target membership is not available';
  END IF;
  IF target_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30327,
          MESSAGE_TEXT = 'member approval target status changed';
  END IF;

  SET out_occurred_at = UTC_TIMESTAMP(6);
  UPDATE class_members
  SET status = 'approved',
      display_name_in_class = p_display_name_in_class,
      student_number = p_student_number,
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_target_member_id
    AND class_id = p_class_id
    AND user_id = p_target_user_id
    AND BINARY role = BINARY 'student'
    AND BINARY status = BINARY 'pending';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30306,
          MESSAGE_TEXT = 'member approval compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_target_member_id, p_class_id, 'pending', 'approved',
    p_actor_user_id, p_actor_member_id, NULL, NULL, out_occurred_at
  );
  CALL assert_class_invariants(p_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE reject_class_member(
  IN p_class_id BIGINT,
  IN p_actor_user_id BIGINT,
  IN p_actor_member_id BIGINT,
  IN p_target_user_id BIGINT,
  IN p_target_member_id BIGINT,
  IN p_reason VARCHAR(300),
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Reject one pending student membership'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE actor_user_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_user_is_present BOOLEAN DEFAULT FALSE;
  DECLARE actor_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_present BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE profile_user_id BIGINT DEFAULT NULL;
  DECLARE profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE profile_temporary BOOLEAN DEFAULT TRUE;
  DECLARE transition_reason VARCHAR(300);

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'member rejection requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();
  IF p_actor_user_id = p_target_user_id OR p_actor_member_id = p_target_member_id THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30308,
          MESSAGE_TEXT = 'member rejection actor and target must be distinct';
  END IF;

  BEGIN
    DECLARE users_done BOOLEAN DEFAULT FALSE;
    DECLARE current_user_id BIGINT;
    DECLARE current_user_active BOOLEAN;
    DECLARE current_user_deleted_at DATETIME(6);
    DECLARE user_cursor CURSOR FOR
      SELECT id, is_active, deleted_at
      FROM users FORCE INDEX (PRIMARY)
      WHERE id IN (p_actor_user_id, p_target_user_id)
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET users_done = TRUE;

    OPEN user_cursor;
    user_lock_loop: LOOP
      FETCH user_cursor INTO current_user_id, current_user_active, current_user_deleted_at;
      IF users_done THEN
        LEAVE user_lock_loop;
      END IF;
      IF current_user_id = p_actor_user_id
        AND current_user_active = TRUE
        AND current_user_deleted_at IS NULL THEN
        SET actor_user_is_valid = TRUE;
      END IF;
      IF current_user_id = p_target_user_id THEN
        SET target_user_is_present = TRUE;
      END IF;
    END LOOP;
    CLOSE user_cursor;
  END;
  IF actor_user_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30309,
          MESSAGE_TEXT = 'member rejection actor account is not eligible';
  END IF;
  IF target_user_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30329,
          MESSAGE_TEXT = 'member rejection target account does not exist';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);
  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30332,
          MESSAGE_TEXT = 'member rejection target class is suspended';
  END IF;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30307,
          MESSAGE_TEXT = 'member rejection target class is not available';
  END IF;
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
        AND id IN (p_actor_member_id, p_target_member_id)
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
      IF current_member_id = p_actor_member_id
        AND current_member_user_id = p_actor_user_id
        AND BINARY current_member_role = BINARY 'teacher'
        AND BINARY current_member_status = BINARY 'approved' THEN
        SET actor_member_is_valid = TRUE;
      END IF;
      IF current_member_id = p_target_member_id
        AND current_member_user_id = p_target_user_id
        AND BINARY current_member_role = BINARY 'student' THEN
        SET target_member_is_present = TRUE;
        IF BINARY current_member_status = BINARY 'pending' THEN
          SET target_member_is_valid = TRUE;
        END IF;
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;
  IF actor_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30310,
          MESSAGE_TEXT = 'member rejection actor membership is not eligible';
  END IF;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO profile_user_id, profile_status, profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF profile_user_id IS NULL
    OR BINARY profile_status <> BINARY 'active'
    OR profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30311,
          MESSAGE_TEXT = 'member rejection actor teacher profile is not eligible';
  END IF;
  IF target_member_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30330,
          MESSAGE_TEXT = 'member rejection target membership is not available';
  END IF;
  IF target_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30331,
          MESSAGE_TEXT = 'member rejection target status changed';
  END IF;

  SET transition_reason = NULLIF(TRIM(p_reason), '');
  SET out_occurred_at = UTC_TIMESTAMP(6);
  UPDATE class_members
  SET status = 'rejected',
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_target_member_id
    AND class_id = p_class_id
    AND user_id = p_target_user_id
    AND BINARY role = BINARY 'student'
    AND BINARY status = BINARY 'pending';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30312,
          MESSAGE_TEXT = 'member rejection compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_target_member_id, p_class_id, 'pending', 'rejected',
    p_actor_user_id, p_actor_member_id, NULL, transition_reason, out_occurred_at
  );
  CALL assert_class_invariants(p_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE remove_class_member(
  IN p_class_id BIGINT,
  IN p_actor_user_id BIGINT,
  IN p_actor_member_id BIGINT,
  IN p_target_user_id BIGINT,
  IN p_target_member_id BIGINT,
  IN p_reason VARCHAR(300),
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Remove one approved student membership'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE actor_user_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_user_is_present BOOLEAN DEFAULT FALSE;
  DECLARE actor_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_present BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE profile_user_id BIGINT DEFAULT NULL;
  DECLARE profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE profile_temporary BOOLEAN DEFAULT TRUE;
  DECLARE transition_reason VARCHAR(300);

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'member removal requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();
  IF p_actor_user_id = p_target_user_id OR p_actor_member_id = p_target_member_id THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30314,
          MESSAGE_TEXT = 'member removal actor and target must be distinct';
  END IF;

  BEGIN
    DECLARE users_done BOOLEAN DEFAULT FALSE;
    DECLARE current_user_id BIGINT;
    DECLARE current_user_active BOOLEAN;
    DECLARE current_user_deleted_at DATETIME(6);
    DECLARE user_cursor CURSOR FOR
      SELECT id, is_active, deleted_at
      FROM users FORCE INDEX (PRIMARY)
      WHERE id IN (p_actor_user_id, p_target_user_id)
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET users_done = TRUE;

    OPEN user_cursor;
    user_lock_loop: LOOP
      FETCH user_cursor INTO current_user_id, current_user_active, current_user_deleted_at;
      IF users_done THEN
        LEAVE user_lock_loop;
      END IF;
      IF current_user_id = p_actor_user_id
        AND current_user_active = TRUE
        AND current_user_deleted_at IS NULL THEN
        SET actor_user_is_valid = TRUE;
      END IF;
      IF current_user_id = p_target_user_id THEN
        SET target_user_is_present = TRUE;
      END IF;
    END LOOP;
    CLOSE user_cursor;
  END;
  IF actor_user_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30315,
          MESSAGE_TEXT = 'member removal actor account is not eligible';
  END IF;
  IF target_user_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30333,
          MESSAGE_TEXT = 'member removal target account does not exist';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);
  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30336,
          MESSAGE_TEXT = 'member removal target class is suspended';
  END IF;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30313,
          MESSAGE_TEXT = 'member removal target class is not available';
  END IF;
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
        AND id IN (p_actor_member_id, p_target_member_id)
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
      IF current_member_id = p_actor_member_id
        AND current_member_user_id = p_actor_user_id
        AND BINARY current_member_role = BINARY 'teacher'
        AND BINARY current_member_status = BINARY 'approved' THEN
        SET actor_member_is_valid = TRUE;
      END IF;
      IF current_member_id = p_target_member_id
        AND current_member_user_id = p_target_user_id
        AND BINARY current_member_role = BINARY 'student' THEN
        SET target_member_is_present = TRUE;
        IF BINARY current_member_status = BINARY 'approved' THEN
          SET target_member_is_valid = TRUE;
        END IF;
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;
  IF actor_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30316,
          MESSAGE_TEXT = 'member removal actor membership is not eligible';
  END IF;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO profile_user_id, profile_status, profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF profile_user_id IS NULL
    OR BINARY profile_status <> BINARY 'active'
    OR profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30317,
          MESSAGE_TEXT = 'member removal actor teacher profile is not eligible';
  END IF;
  IF target_member_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30334,
          MESSAGE_TEXT = 'member removal target membership is not available';
  END IF;
  IF target_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30335,
          MESSAGE_TEXT = 'member removal target status changed';
  END IF;

  SET transition_reason = NULLIF(TRIM(p_reason), '');
  SET out_occurred_at = UTC_TIMESTAMP(6);
  UPDATE class_members
  SET status = 'removed',
      student_number = NULL,
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_target_member_id
    AND class_id = p_class_id
    AND user_id = p_target_user_id
    AND BINARY role = BINARY 'student'
    AND BINARY status = BINARY 'approved';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30318,
          MESSAGE_TEXT = 'member removal compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_target_member_id, p_class_id, 'approved', 'removed',
    p_actor_user_id, p_actor_member_id, NULL, transition_reason, out_occurred_at
  );
  CALL assert_class_invariants(p_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE allow_class_member_rejoin(
  IN p_class_id BIGINT,
  IN p_actor_user_id BIGINT,
  IN p_actor_member_id BIGINT,
  IN p_target_user_id BIGINT,
  IN p_target_member_id BIGINT,
  IN p_reason VARCHAR(300),
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Allow one removed student membership to request rejoin'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE actor_user_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_user_is_present BOOLEAN DEFAULT FALSE;
  DECLARE actor_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_present BOOLEAN DEFAULT FALSE;
  DECLARE target_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE profile_user_id BIGINT DEFAULT NULL;
  DECLARE profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE profile_temporary BOOLEAN DEFAULT TRUE;
  DECLARE transition_reason VARCHAR(300);

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'member rejoin allowance requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();
  IF p_actor_user_id = p_target_user_id OR p_actor_member_id = p_target_member_id THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30320,
          MESSAGE_TEXT = 'member rejoin actor and target must be distinct';
  END IF;

  BEGIN
    DECLARE users_done BOOLEAN DEFAULT FALSE;
    DECLARE current_user_id BIGINT;
    DECLARE current_user_active BOOLEAN;
    DECLARE current_user_deleted_at DATETIME(6);
    DECLARE user_cursor CURSOR FOR
      SELECT id, is_active, deleted_at
      FROM users FORCE INDEX (PRIMARY)
      WHERE id IN (p_actor_user_id, p_target_user_id)
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET users_done = TRUE;

    OPEN user_cursor;
    user_lock_loop: LOOP
      FETCH user_cursor INTO current_user_id, current_user_active, current_user_deleted_at;
      IF users_done THEN
        LEAVE user_lock_loop;
      END IF;
      IF current_user_id = p_actor_user_id
        AND current_user_active = TRUE
        AND current_user_deleted_at IS NULL THEN
        SET actor_user_is_valid = TRUE;
      END IF;
      IF current_user_id = p_target_user_id THEN
        SET target_user_is_present = TRUE;
      END IF;
    END LOOP;
    CLOSE user_cursor;
  END;
  IF actor_user_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30321,
          MESSAGE_TEXT = 'member rejoin actor account is not eligible';
  END IF;
  IF target_user_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30337,
          MESSAGE_TEXT = 'member rejoin target account does not exist';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);
  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30340,
          MESSAGE_TEXT = 'member rejoin target class is suspended';
  END IF;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30319,
          MESSAGE_TEXT = 'member rejoin target class is not available';
  END IF;
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
        AND id IN (p_actor_member_id, p_target_member_id)
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
      IF current_member_id = p_actor_member_id
        AND current_member_user_id = p_actor_user_id
        AND BINARY current_member_role = BINARY 'teacher'
        AND BINARY current_member_status = BINARY 'approved' THEN
        SET actor_member_is_valid = TRUE;
      END IF;
      IF current_member_id = p_target_member_id
        AND current_member_user_id = p_target_user_id
        AND BINARY current_member_role = BINARY 'student' THEN
        SET target_member_is_present = TRUE;
        IF BINARY current_member_status = BINARY 'removed' THEN
          SET target_member_is_valid = TRUE;
        END IF;
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;
  IF actor_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30322,
          MESSAGE_TEXT = 'member rejoin actor membership is not eligible';
  END IF;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO profile_user_id, profile_status, profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF profile_user_id IS NULL
    OR BINARY profile_status <> BINARY 'active'
    OR profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30323,
          MESSAGE_TEXT = 'member rejoin actor teacher profile is not eligible';
  END IF;
  IF target_member_is_present = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30338,
          MESSAGE_TEXT = 'member rejoin target membership is not available';
  END IF;
  IF target_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30339,
          MESSAGE_TEXT = 'member rejoin target status changed';
  END IF;

  SET transition_reason = NULLIF(TRIM(p_reason), '');
  SET out_occurred_at = UTC_TIMESTAMP(6);
  UPDATE class_members
  SET status = 'rejoin_allowed',
      row_version = row_version + 1,
      status_changed_at = out_occurred_at,
      updated_at = out_occurred_at
  WHERE id = p_target_member_id
    AND class_id = p_class_id
    AND user_id = p_target_user_id
    AND BINARY role = BINARY 'student'
    AND BINARY status = BINARY 'removed';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30324,
          MESSAGE_TEXT = 'member rejoin compare-and-set failed';
  END IF;

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    p_target_member_id, p_class_id, 'removed', 'rejoin_allowed',
    p_actor_user_id, p_actor_member_id, NULL, transition_reason, out_occurred_at
  );
  CALL assert_class_invariants(p_class_id);
END//

DELIMITER ;
