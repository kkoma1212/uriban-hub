-- T-HUB-62 phase-0002 invariant-core account-deletion routine draft.
-- Provisional target: MariaDB 11.4 LTS.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- The caller locks the user/session, verifies the current password, and then
-- discovers affected class ids without taking class/member row locks before
-- CALL. This routine validates the list, repeats the user lock, locks classes in ascending order,
-- performs a current locking membership read, and requires exact set equality
-- before any write.
-- Tokens, sessions, consents, later-phase cleanup, audit, and rate limits stay
-- caller-owned in the same transaction. Any error requires a full rollback.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

DELIMITER //

CREATE DEFINER = 'classhub_routine'@'%' PROCEDURE delete_user_account(
  IN p_user_id BIGINT,
  IN p_expected_class_ids_json LONGTEXT,
  IN p_unusable_password_hash VARCHAR(255),
  OUT out_actor_class_id BIGINT,
  OUT out_occurred_at DATETIME(6)
)
SQL SECURITY DEFINER
MODIFIES SQL DATA
COMMENT 'Delete one account after exact affected-class lock-set validation'
BEGIN
  DECLARE expected_class_count INT DEFAULT 0;
  DECLARE expected_index INT DEFAULT 0;
  DECLARE expected_class_id BIGINT;
  DECLARE previous_expected_class_id BIGINT DEFAULT 0;
  DECLARE expected_class_id_text VARCHAR(32);
  DECLARE locked_user_id BIGINT DEFAULT NULL;
  DECLARE locked_user_active BOOLEAN DEFAULT FALSE;
  DECLARE locked_user_deleted_at DATETIME(6);
  DECLARE actual_class_count INT DEFAULT 0;
  DECLARE previous_actual_class_id BIGINT DEFAULT 0;

  IF @@SESSION.in_transaction = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30401,
          MESSAGE_TEXT = 'account deletion requires a caller transaction';
  END IF;
  -- An account with no membership never calls a class helper, so verify the
  -- effective active transaction mode at routine entry.
  CALL assert_read_committed_session();
  IF p_expected_class_ids_json IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30402,
          MESSAGE_TEXT = 'account deletion class list must be valid JSON';
  END IF;
  IF OCTET_LENGTH(p_expected_class_ids_json) > 131072 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30404,
          MESSAGE_TEXT = 'account deletion class list exceeds the reviewed bound';
  END IF;
  IF JSON_VALID(p_expected_class_ids_json) = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30402,
          MESSAGE_TEXT = 'account deletion class list must be valid JSON';
  END IF;
  IF BINARY JSON_TYPE(p_expected_class_ids_json) <> BINARY 'ARRAY' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30403,
          MESSAGE_TEXT = 'account deletion class list must be an array';
  END IF;

  SET expected_class_count = JSON_LENGTH(p_expected_class_ids_json);
  IF expected_class_count > 4096 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30404,
          MESSAGE_TEXT = 'account deletion class list exceeds the reviewed bound';
  END IF;

  -- Validate positive signed BIGINT values, strict ascending order, and no
  -- duplicates before taking any row lock.
  SET expected_index = 0;
  WHILE expected_index < expected_class_count DO
    IF BINARY JSON_TYPE(
      JSON_EXTRACT(p_expected_class_ids_json, CONCAT('$[', expected_index, ']'))
    ) <> BINARY 'INTEGER' THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30405,
            MESSAGE_TEXT = 'account deletion class list contains a non-integer';
    END IF;

    SET expected_class_id_text = JSON_UNQUOTE(
      JSON_EXTRACT(p_expected_class_ids_json, CONCAT('$[', expected_index, ']'))
    );
    IF expected_class_id_text NOT REGEXP '^[1-9][0-9]*$'
      OR OCTET_LENGTH(expected_class_id_text) > 19
      OR (
        OCTET_LENGTH(expected_class_id_text) = 19
        AND BINARY expected_class_id_text > BINARY '9223372036854775807'
      ) THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30406,
            MESSAGE_TEXT = 'account deletion class id is outside positive BIGINT';
    END IF;

    SET expected_class_id = CAST(expected_class_id_text AS UNSIGNED);
    IF expected_index > 0 AND expected_class_id <= previous_expected_class_id THEN
      SIGNAL SQLSTATE '45000'
        SET MYSQL_ERRNO = 30407,
            MESSAGE_TEXT = 'account deletion class list must be strictly ascending';
    END IF;

    SET previous_expected_class_id = expected_class_id;
    SET expected_index = expected_index + 1;
  END WHILE;

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
      SET MYSQL_ERRNO = 30408,
          MESSAGE_TEXT = 'account deletion user is not active';
  END IF;

  -- The governing order is user first, followed by class ids in ascending
  -- order. The JSON values were fully validated before the user lock.
  SET expected_index = 0;
  WHILE expected_index < expected_class_count DO
    SET expected_class_id = CAST(JSON_UNQUOTE(
      JSON_EXTRACT(p_expected_class_ids_json, CONCAT('$[', expected_index, ']'))
    ) AS UNSIGNED);
    CALL lock_class_invariant_boundary(expected_class_id);
    SET expected_index = expected_index + 1;
  END WHILE;

  SET out_actor_class_id = NULL;

  -- Current locking read: compare every distinct actual class id with the
  -- already validated list and reject a live approved teacher before writes.
  BEGIN
    DECLARE memberships_done BOOLEAN DEFAULT FALSE;
    DECLARE current_member_id BIGINT;
    DECLARE current_class_id BIGINT;
    DECLARE member_role_value VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE current_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE current_class_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE listed_class_id BIGINT;
    DECLARE membership_cursor CURSOR FOR
      SELECT id, class_id, role, status
      FROM class_members FORCE INDEX (class_members_user_class_id_idx)
      WHERE user_id = p_user_id
      ORDER BY class_id, id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET memberships_done = TRUE;

    OPEN membership_cursor;
    membership_validation_loop: LOOP
      FETCH membership_cursor
      INTO current_member_id, current_class_id, member_role_value, current_status;
      IF memberships_done THEN
        LEAVE membership_validation_loop;
      END IF;

      IF actual_class_count = 0 OR current_class_id <> previous_actual_class_id THEN
        SET actual_class_count = actual_class_count + 1;
        IF actual_class_count > expected_class_count THEN
          SIGNAL SQLSTATE '45000'
            SET MYSQL_ERRNO = 30409,
                MESSAGE_TEXT = 'account deletion class set grew before the locking read';
        END IF;
        SET listed_class_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(
          p_expected_class_ids_json, CONCAT('$[', actual_class_count - 1, ']')
        )) AS UNSIGNED);
        IF current_class_id <> listed_class_id THEN
          SIGNAL SQLSTATE '45000'
            SET MYSQL_ERRNO = 30410,
                MESSAGE_TEXT = 'account deletion actual class set does not match caller list';
        END IF;
        SET previous_actual_class_id = current_class_id;
      END IF;

      SELECT status
      INTO current_class_status
      FROM classes
      WHERE id = current_class_id
      FOR UPDATE;
      IF BINARY member_role_value = BINARY 'teacher'
        AND BINARY current_status = BINARY 'approved'
        AND BINARY current_class_status IN (BINARY 'active', BINARY 'suspended') THEN
        SIGNAL SQLSTATE '45000'
          SET MYSQL_ERRNO = 30411,
              MESSAGE_TEXT = 'account deletion is blocked by a live class teacher';
      END IF;

      IF BINARY current_status IN (BINARY 'pending', BINARY 'approved') THEN
        SET out_actor_class_id = current_class_id;
      END IF;
    END LOOP;
    CLOSE membership_cursor;
  END;

  IF actual_class_count <> expected_class_count THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30412,
          MESSAGE_TEXT = 'account deletion actual class set is smaller than caller list';
  END IF;
  IF p_unusable_password_hash IS NULL OR p_unusable_password_hash = '' THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30413,
          MESSAGE_TEXT = 'account deletion requires a non-empty unusable password hash';
  END IF;

  SET out_occurred_at = UTC_TIMESTAMP(6);

  BEGIN
    DECLARE memberships_done BOOLEAN DEFAULT FALSE;
    DECLARE current_member_id BIGINT;
    DECLARE current_class_id BIGINT;
    DECLARE member_role_value VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE current_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin;
    DECLARE membership_cursor CURSOR FOR
      SELECT id, class_id, role, status
      FROM class_members FORCE INDEX (class_members_user_class_id_idx)
      WHERE user_id = p_user_id
      ORDER BY class_id, id
      FOR UPDATE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET memberships_done = TRUE;

    OPEN membership_cursor;
    membership_write_loop: LOOP
      FETCH membership_cursor
      INTO current_member_id, current_class_id, member_role_value, current_status;
      IF memberships_done THEN
        LEAVE membership_write_loop;
      END IF;

      IF BINARY member_role_value = BINARY 'student'
        AND BINARY current_status IN (BINARY 'pending', BINARY 'approved') THEN
        UPDATE class_members
        SET status = 'account_deleted',
            display_name_in_class = NULL,
            student_number = NULL,
            row_version = row_version + 1,
            status_changed_at = out_occurred_at,
            updated_at = out_occurred_at
        WHERE id = current_member_id
          AND class_id = current_class_id
          AND BINARY role = BINARY 'student'
          AND BINARY status = BINARY current_status;
        IF ROW_COUNT() <> 1 THEN
          SIGNAL SQLSTATE '45000'
            SET MYSQL_ERRNO = 30414,
                MESSAGE_TEXT = 'account deletion membership compare-and-set failed';
        END IF;

        INSERT INTO class_member_status_history (
          member_id, class_id, from_status, to_status,
          actor_user_id, actor_member_id, actor_operator_id, reason, created_at
        ) VALUES (
          current_member_id, current_class_id, current_status, 'account_deleted',
          p_user_id,
          IF(BINARY current_status = BINARY 'approved', current_member_id, NULL),
          NULL, NULL, out_occurred_at
        );
      ELSE
        -- Preserve PostgreSQL parity: historical rows are PII-scrubbed without
        -- inventing a status transition or incrementing row_version.
        UPDATE class_members
        SET display_name_in_class = NULL,
            student_number = NULL,
            updated_at = out_occurred_at
        WHERE id = current_member_id AND class_id = current_class_id;
      END IF;
    END LOOP;
    CLOSE membership_cursor;
  END;

  UPDATE users
  SET email_normalized = CONCAT('deleted+', p_user_id, '@invalid.local'),
      display_name = '탈퇴한 사용자',
      password_hash = p_unusable_password_hash,
      is_active = FALSE,
      failed_login_attempts = 0,
      locked_until = NULL,
      password_last_changed_at = out_occurred_at,
      updated_at = out_occurred_at,
      deleted_at = out_occurred_at,
      anonymized_at = out_occurred_at
  WHERE id = p_user_id AND is_active = TRUE AND deleted_at IS NULL;
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MYSQL_ERRNO = 30415,
          MESSAGE_TEXT = 'account deletion user compare-and-set failed';
  END IF;

  SET expected_index = 0;
  WHILE expected_index < expected_class_count DO
    SET expected_class_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(
      p_expected_class_ids_json, CONCAT('$[', expected_index, ']')
    )) AS UNSIGNED);
    CALL assert_class_invariants(expected_class_id);
    SET expected_index = expected_index + 1;
  END WHILE;
END//

DELIMITER ;
