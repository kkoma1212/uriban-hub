-- T-HUB-62 phase-0002 invariant-core class lifecycle routine draft.
-- Provisional target: MariaDB 11.4 LTS.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- Authorization, audit, idempotency, and response persistence remain in the
-- caller-owned transaction. These routines own the invariant-bearing writes,
-- revalidate the locked domain state, and return the one database timestamp
-- that the caller must reuse. Any CALL error requires a full caller rollback.
-- The caller supplies five independently generated cryptographic invite-code
-- candidates; only a diagnostic-proven code-unique 1062 is retried inside the
-- narrow INSERT block, and every other 1062 is RESIGNALed.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE create_class_with_teacher_and_invite(
  IN p_actor_user_id BIGINT,
  IN p_name TEXT,
  IN p_academic_year INT,
  IN p_grade INT,
  IN p_edu_office_code VARCHAR(3),
  IN p_school_code VARCHAR(7),
  IN p_expected_student_count INT,
  IN p_invite_code_1 VARCHAR(8),
  IN p_invite_code_2 VARCHAR(8),
  IN p_invite_code_3 VARCHAR(8),
  IN p_invite_code_4 VARCHAR(8),
  IN p_invite_code_5 VARCHAR(8),
  OUT out_class_id BIGINT,
  OUT out_teacher_member_id BIGINT,
  OUT out_invite_id BIGINT,
  OUT out_invite_code VARCHAR(8),
  OUT out_invite_created_at DATETIME(6),
  OUT out_invite_expires_at DATETIME(6),
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Create one class with its teacher and initial invite'
BEGIN
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE locked_user_verified_at DATETIME(6);
  DECLARE current_member_id BIGINT DEFAULT NULL;
  DECLARE locked_profile_user_id BIGINT DEFAULT NULL;
  DECLARE locked_profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_profile_temporary BOOLEAN DEFAULT TRUE;
  DECLARE locked_school_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE duplicate_class_id BIGINT DEFAULT NULL;
  DECLARE candidate_attempt INT DEFAULT 1;
  DECLARE candidate_code VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE duplicate_code BOOLEAN DEFAULT FALSE;
  DECLARE diagnostic_count INT DEFAULT 0;
  DECLARE duplicate_errno INT DEFAULT 0;
  DECLARE duplicate_message TEXT;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30101,
          MESSAGE_TEXT = 'class creation requires a caller transaction';
  END IF;
  -- Creation has no parent class row to lock before INSERT, so verify the
  -- effective active transaction mode before any protected write.
  CALL assert_read_committed_session();

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at, email_verified_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at, locked_user_verified_at
    FROM users
    WHERE id = p_actor_user_id
    FOR UPDATE;
  END;
  IF locked_user_id IS NULL
    OR locked_user_active = FALSE
    OR locked_user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30102,
          MESSAGE_TEXT = 'class creation actor account is not active';
  END IF;
  IF locked_user_verified_at IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30124,
          MESSAGE_TEXT = 'class creation actor email is not verified';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET current_member_id = NULL;
    SELECT id
    INTO current_member_id
    FROM class_members
    WHERE current_user_id = p_actor_user_id
    FOR UPDATE;
  END;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO locked_profile_user_id, locked_profile_status, locked_profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF locked_profile_user_id IS NULL
    OR BINARY locked_profile_status <> BINARY 'active'
    OR locked_profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30104,
          MESSAGE_TEXT = 'class creation actor teacher profile is not eligible';
  END IF;
  IF current_member_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30103,
          MESSAGE_TEXT = 'class creation actor already has a current membership';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_school_kind = NULL;
    SELECT school_kind
    INTO locked_school_kind
    FROM schools
    WHERE edu_office_code = p_edu_office_code
      AND school_code = p_school_code
    FOR UPDATE;
  END;
  IF locked_school_kind IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30105,
          MESSAGE_TEXT = 'class creation school does not exist';
  END IF;
  IF BINARY locked_school_kind = BINARY 'elementary' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30106,
          MESSAGE_TEXT = 'class creation school kind is not supported';
  END IF;
  IF p_grade > 3 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30125,
          MESSAGE_TEXT = 'class creation grade is not allowed';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET duplicate_class_id = NULL;
    SELECT id
    INTO duplicate_class_id
    FROM classes
    WHERE edu_office_code = p_edu_office_code
      AND school_code = p_school_code
      AND academic_year = p_academic_year
      AND grade = p_grade
      AND BINARY name_normalized = BINARY LOWER(
        REGEXP_REPLACE(
          TRIM(p_name),
          '[\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{2000}-\\x{2006}\\x{2008}-\\x{200A}\\x{2028}-\\x{2029}\\x{205F}\\x{3000}]+',
          ' '
        ) COLLATE utf8mb4_uca1400_as_ci
      )
      AND BINARY status IN (BINARY 'active', BINARY 'suspended')
    ORDER BY id
    LIMIT 1;
  END;
  IF duplicate_class_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30107,
          MESSAGE_TEXT = 'class creation duplicates an active class identity';
  END IF;

  SET out_occurred_at = UTC_TIMESTAMP(6);
  SET out_invite_created_at = out_occurred_at;
  SET out_invite_expires_at = DATE_ADD(out_occurred_at, INTERVAL 14 DAY);
  SET out_invite_id = NULL;
  SET out_invite_code = NULL;

  INSERT INTO classes (
    name, academic_year, grade, edu_office_code, school_code,
    expected_student_count, created_by_user_id, created_at, updated_at
  ) VALUES (
    p_name, p_academic_year, p_grade, p_edu_office_code, p_school_code,
    p_expected_student_count, p_actor_user_id, out_occurred_at, out_occurred_at
  );
  SET out_class_id = LAST_INSERT_ID();

  -- No target class exists before INSERT. Lock the new row before child writes.
  CALL lock_class_invariant_boundary(out_class_id);

  INSERT INTO class_members (
    class_id, user_id, role, status, status_changed_at, created_at, updated_at
  ) VALUES (
    out_class_id, p_actor_user_id, 'teacher', 'approved',
    out_occurred_at, out_occurred_at, out_occurred_at
  );
  SET out_teacher_member_id = LAST_INSERT_ID();

  INSERT INTO class_member_status_history (
    member_id, class_id, from_status, to_status,
    actor_user_id, actor_member_id, actor_operator_id, reason, created_at
  ) VALUES (
    out_teacher_member_id, out_class_id, NULL, 'approved',
    p_actor_user_id, out_teacher_member_id, NULL, NULL, out_occurred_at
  );

  candidate_loop: WHILE candidate_attempt <= 5 DO
    SET candidate_code = CASE candidate_attempt
      WHEN 1 THEN p_invite_code_1
      WHEN 2 THEN p_invite_code_2
      WHEN 3 THEN p_invite_code_3
      WHEN 4 THEN p_invite_code_4
      ELSE p_invite_code_5
    END;
    SET duplicate_code = FALSE;
    SET diagnostic_count = 0;
    SET duplicate_errno = 0;
    SET duplicate_message = NULL;

    BEGIN
      DECLARE CONTINUE HANDLER FOR 1062
      BEGIN
        GET DIAGNOSTICS diagnostic_count = NUMBER;
        GET DIAGNOSTICS CONDITION diagnostic_count
          duplicate_errno = MYSQL_ERRNO,
          duplicate_message = MESSAGE_TEXT;
        IF duplicate_errno IS NULL
          OR duplicate_errno <> 1062
          OR duplicate_message IS NULL
          OR duplicate_message NOT REGEXP 'for key ''class_invite_codes_code_unique''$' THEN
          RESIGNAL;
        END IF;
        SET duplicate_code = TRUE;
      END;
      INSERT INTO class_invite_codes (
        class_id, code, expires_at, created_by_member_id, created_at
      ) VALUES (
        out_class_id, candidate_code, out_invite_expires_at,
        out_teacher_member_id, out_invite_created_at
      );
      IF duplicate_code = FALSE THEN
        SET out_invite_id = LAST_INSERT_ID();
        SET out_invite_code = candidate_code;
      END IF;
    END;

    IF out_invite_id IS NOT NULL THEN
      LEAVE candidate_loop;
    END IF;
    SET candidate_attempt = candidate_attempt + 1;
  END WHILE;

  IF out_invite_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30108,
          MESSAGE_TEXT = 'class creation exhausted five invite code candidates';
  END IF;

  CALL assert_class_invariants(out_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE archive_class(
  IN p_class_id BIGINT,
  IN p_actor_user_id BIGINT,
  IN p_actor_member_id BIGINT,
  IN p_class_name_confirmation TEXT,
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Archive a class, its current members, and its open invite'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_class_name TEXT;
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE actor_member_is_valid BOOLEAN DEFAULT FALSE;
  DECLARE locked_profile_user_id BIGINT DEFAULT NULL;
  DECLARE locked_profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_profile_temporary BOOLEAN DEFAULT TRUE;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'class archive requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at
    FROM users
    WHERE id = p_actor_user_id
    FOR UPDATE;
  END;
  IF locked_user_id IS NULL OR locked_user_active = FALSE OR locked_user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30111,
          MESSAGE_TEXT = 'class archive actor account is not active';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);

  SELECT status, name
  INTO locked_class_status, locked_class_name
  FROM classes
  WHERE id = p_class_id
  FOR UPDATE;
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30126,
          MESSAGE_TEXT = 'class archive target is suspended';
  END IF;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30109,
          MESSAGE_TEXT = 'class archive target state conflicts';
  END IF;
  -- Establish the complete current-member lock set before profile/invite locks.
  BEGIN
    DECLARE members_done BOOLEAN DEFAULT FALSE;
    DECLARE locked_member_id BIGINT;
    DECLARE locked_member_user_id BIGINT;
    DECLARE locked_member_role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE locked_member_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE member_cursor CURSOR FOR
      SELECT id, user_id, role, status
      FROM class_members
      WHERE class_id = p_class_id
        AND BINARY status IN (BINARY 'pending', BINARY 'approved')
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET members_done = TRUE;

    OPEN member_cursor;
    member_lock_loop: LOOP
      FETCH member_cursor
      INTO locked_member_id, locked_member_user_id, locked_member_role, locked_member_status;
      IF members_done THEN
        LEAVE member_lock_loop;
      END IF;
      IF locked_member_id = p_actor_member_id
        AND locked_member_user_id = p_actor_user_id
        AND BINARY locked_member_role = BINARY 'teacher'
        AND BINARY locked_member_status = BINARY 'approved' THEN
        SET actor_member_is_valid = TRUE;
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;
  IF actor_member_is_valid = FALSE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30112,
          MESSAGE_TEXT = 'class archive actor membership is not eligible';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO locked_profile_user_id, locked_profile_status, locked_profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF locked_profile_user_id IS NULL
    OR BINARY locked_profile_status <> BINARY 'active'
    OR locked_profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30113,
          MESSAGE_TEXT = 'class archive actor teacher profile is not eligible';
  END IF;
  IF p_class_name_confirmation IS NULL
    OR BINARY locked_class_name <> BINARY p_class_name_confirmation THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30110,
          MESSAGE_TEXT = 'class archive name confirmation does not match';
  END IF;

  -- Lock every open invite before the first write.
  BEGIN
    DECLARE invites_done BOOLEAN DEFAULT FALSE;
    DECLARE locked_invite_id BIGINT;
    DECLARE invite_cursor CURSOR FOR
      SELECT id
      FROM class_invite_codes
      WHERE class_id = p_class_id AND revoked_at IS NULL
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET invites_done = TRUE;

    OPEN invite_cursor;
    invite_lock_loop: LOOP
      FETCH invite_cursor INTO locked_invite_id;
      IF invites_done THEN
        LEAVE invite_lock_loop;
      END IF;
    END LOOP;
    CLOSE invite_cursor;
  END;

  SET out_occurred_at = UTC_TIMESTAMP(6);

  UPDATE classes
  SET status = 'archived',
      row_version = row_version + 1,
      archived_at = out_occurred_at,
      archived_by_user_id = p_actor_user_id,
      archived_by_operator_id = NULL,
      updated_at = out_occurred_at
  WHERE id = p_class_id AND BINARY status = BINARY 'active';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30114,
          MESSAGE_TEXT = 'class archive compare-and-set failed';
  END IF;

  BEGIN
    DECLARE invites_done BOOLEAN DEFAULT FALSE;
    DECLARE current_invite_id BIGINT;
    DECLARE current_invite_revoked_at DATETIME(6);
    DECLARE invite_cursor CURSOR FOR
      SELECT id, revoked_at
      FROM class_invite_codes
      WHERE class_id = p_class_id
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET invites_done = TRUE;

    OPEN invite_cursor;
    invite_write_loop: LOOP
      FETCH invite_cursor INTO current_invite_id, current_invite_revoked_at;
      IF invites_done THEN
        LEAVE invite_write_loop;
      END IF;

      IF current_invite_revoked_at IS NULL THEN
        UPDATE class_invite_codes
        SET revoked_at = out_occurred_at,
            revoked_by_member_id = p_actor_member_id,
            revoked_by_operator_id = NULL,
            revoke_reason = '반 아카이브'
        WHERE id = current_invite_id AND revoked_at IS NULL;
        IF ROW_COUNT() <> 1 THEN
          SIGNAL SQLSTATE '45000'
            SET MYSQL_ERRNO = 30115,
                MESSAGE_TEXT = 'class archive invite transition failed';
        END IF;
      END IF;
    END LOOP;
    CLOSE invite_cursor;
  END;

  BEGIN
    DECLARE members_done BOOLEAN DEFAULT FALSE;
    DECLARE current_member_id BIGINT;
    DECLARE current_member_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE next_member_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE member_cursor CURSOR FOR
      SELECT id, status
      FROM class_members
      WHERE class_id = p_class_id
      ORDER BY id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET members_done = TRUE;

    OPEN member_cursor;
    member_write_loop: LOOP
      FETCH member_cursor INTO current_member_id, current_member_status;
      IF members_done THEN
        LEAVE member_write_loop;
      END IF;

      IF BINARY current_member_status IN (BINARY 'pending', BINARY 'approved') THEN
        SET next_member_status = IF(
          BINARY current_member_status = BINARY 'pending', 'canceled', 'archived'
        );
        UPDATE class_members
        SET status = next_member_status,
            student_number = NULL,
            row_version = row_version + 1,
            status_changed_at = out_occurred_at,
            updated_at = out_occurred_at
        WHERE id = current_member_id
          AND class_id = p_class_id
          AND BINARY status = BINARY current_member_status;
        IF ROW_COUNT() <> 1 THEN
          SIGNAL SQLSTATE '45000'
            SET MYSQL_ERRNO = 30116,
                MESSAGE_TEXT = 'class archive member transition failed';
        END IF;

        INSERT INTO class_member_status_history (
          member_id, class_id, from_status, to_status,
          actor_user_id, actor_member_id, actor_operator_id, reason, created_at
        ) VALUES (
          current_member_id, p_class_id, current_member_status, next_member_status,
          p_actor_user_id, p_actor_member_id, NULL, '반 아카이브', out_occurred_at
        );
      END IF;
    END LOOP;
    CLOSE member_cursor;
  END;

  CALL assert_class_invariants(p_class_id);
END//

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE rotate_class_invite(
  IN p_class_id BIGINT,
  IN p_actor_user_id BIGINT,
  IN p_actor_member_id BIGINT,
  IN p_new_code_1 VARCHAR(8),
  IN p_new_code_2 VARCHAR(8),
  IN p_new_code_3 VARCHAR(8),
  IN p_new_code_4 VARCHAR(8),
  IN p_new_code_5 VARCHAR(8),
  OUT out_previous_invite_id BIGINT,
  OUT out_new_invite_id BIGINT,
  OUT out_new_code VARCHAR(8),
  OUT out_new_created_at DATETIME(6),
  OUT out_new_expires_at DATETIME(6),
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Revoke one open invite and create its replacement'
BEGIN
  DECLARE locked_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE locked_member_id BIGINT DEFAULT NULL;
  DECLARE locked_profile_user_id BIGINT DEFAULT NULL;
  DECLARE locked_profile_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE locked_profile_temporary BOOLEAN DEFAULT TRUE;
  DECLARE candidate_attempt INT DEFAULT 1;
  DECLARE candidate_code VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin;
  DECLARE duplicate_code BOOLEAN DEFAULT FALSE;
  DECLARE diagnostic_count INT DEFAULT 0;
  DECLARE duplicate_errno INT DEFAULT 0;
  DECLARE duplicate_message TEXT;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30001,
          MESSAGE_TEXT = 'invite rotation requires a caller transaction';
  END IF;
  CALL assert_read_committed_session();

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_user_id = NULL;
    SELECT id, is_active, deleted_at
    INTO locked_user_id, locked_user_active, locked_user_deleted_at
    FROM users
    WHERE id = p_actor_user_id
    FOR UPDATE;
  END;
  IF locked_user_id IS NULL OR locked_user_active = FALSE OR locked_user_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30118,
          MESSAGE_TEXT = 'invite rotation actor account is not active';
  END IF;

  CALL lock_class_invariant_boundary(p_class_id);

  SELECT status INTO locked_class_status FROM classes WHERE id = p_class_id FOR UPDATE;
  IF BINARY locked_class_status = BINARY 'suspended' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30127,
          MESSAGE_TEXT = 'invite rotation target is suspended';
  END IF;
  IF BINARY locked_class_status <> BINARY 'active' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30117,
          MESSAGE_TEXT = 'invite rotation target is not active';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_member_id = NULL;
    SELECT id
    INTO locked_member_id
    FROM class_members
    WHERE id = p_actor_member_id
      AND class_id = p_class_id
      AND user_id = p_actor_user_id
      AND BINARY role = BINARY 'teacher'
      AND BINARY status = BINARY 'approved'
    FOR UPDATE;
  END;
  IF locked_member_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30119,
          MESSAGE_TEXT = 'invite rotation actor membership is not eligible';
  END IF;

  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET locked_profile_user_id = NULL;
    SELECT user_id, status, temporary_password_must_change
    INTO locked_profile_user_id, locked_profile_status, locked_profile_temporary
    FROM teacher_profiles
    WHERE user_id = p_actor_user_id
    FOR UPDATE;
  END;
  IF locked_profile_user_id IS NULL
    OR BINARY locked_profile_status <> BINARY 'active'
    OR locked_profile_temporary = TRUE THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30120,
          MESSAGE_TEXT = 'invite rotation actor teacher profile is not eligible';
  END IF;

  SET out_previous_invite_id = NULL;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET out_previous_invite_id = NULL;
    SELECT id
    INTO out_previous_invite_id
    FROM class_invite_codes
    WHERE class_id = p_class_id AND revoked_at IS NULL
    ORDER BY id
    LIMIT 1
    FOR UPDATE;
  END;
  IF out_previous_invite_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30121,
          MESSAGE_TEXT = 'invite rotation requires one open invite';
  END IF;

  SET out_occurred_at = UTC_TIMESTAMP(6);
  SET out_new_created_at = out_occurred_at;
  SET out_new_expires_at = DATE_ADD(out_occurred_at, INTERVAL 14 DAY);
  SET out_new_invite_id = NULL;
  SET out_new_code = NULL;

  UPDATE class_invite_codes
  SET revoked_at = out_occurred_at,
      revoked_by_member_id = p_actor_member_id,
      revoked_by_operator_id = NULL,
      revoke_reason = '재발급'
  WHERE id = out_previous_invite_id AND revoked_at IS NULL;
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30122,
          MESSAGE_TEXT = 'invite rotation compare-and-set failed';
  END IF;

  candidate_loop: WHILE candidate_attempt <= 5 DO
    SET candidate_code = CASE candidate_attempt
      WHEN 1 THEN p_new_code_1
      WHEN 2 THEN p_new_code_2
      WHEN 3 THEN p_new_code_3
      WHEN 4 THEN p_new_code_4
      ELSE p_new_code_5
    END;
    SET duplicate_code = FALSE;
    SET diagnostic_count = 0;
    SET duplicate_errno = 0;
    SET duplicate_message = NULL;

    BEGIN
      DECLARE CONTINUE HANDLER FOR 1062
      BEGIN
        GET DIAGNOSTICS diagnostic_count = NUMBER;
        GET DIAGNOSTICS CONDITION diagnostic_count
          duplicate_errno = MYSQL_ERRNO,
          duplicate_message = MESSAGE_TEXT;
        IF duplicate_errno IS NULL
          OR duplicate_errno <> 1062
          OR duplicate_message IS NULL
          OR duplicate_message NOT REGEXP 'for key ''class_invite_codes_code_unique''$' THEN
          RESIGNAL;
        END IF;
        SET duplicate_code = TRUE;
      END;
      INSERT INTO class_invite_codes (
        class_id, code, expires_at, created_by_member_id, created_at
      ) VALUES (
        p_class_id, candidate_code, out_new_expires_at,
        p_actor_member_id, out_new_created_at
      );
      IF duplicate_code = FALSE THEN
        SET out_new_invite_id = LAST_INSERT_ID();
        SET out_new_code = candidate_code;
      END IF;
    END;

    IF out_new_invite_id IS NOT NULL THEN
      LEAVE candidate_loop;
    END IF;
    SET candidate_attempt = candidate_attempt + 1;
  END WHILE;

  IF out_new_invite_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30123,
          MESSAGE_TEXT = 'invite rotation exhausted five invite code candidates';
  END IF;

  CALL assert_class_invariants(p_class_id);
END//

DELIMITER ;
