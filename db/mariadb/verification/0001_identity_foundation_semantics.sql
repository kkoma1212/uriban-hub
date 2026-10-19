-- Destructive only inside its own transaction; intended solely for the isolated phase-1 dev DB.
-- It leaves no product rows. The temporary verification procedure is removed after a PASS.

SET time_zone = '+00:00';

DROP PROCEDURE IF EXISTS classhub_verify_identity_foundation;

DELIMITER //
CREATE PROCEDURE classhub_verify_identity_foundation()
BEGIN
  DECLARE rejected BOOLEAN DEFAULT FALSE;
  DECLARE expected_sqlstate CHAR(5);
  DECLARE caught_sqlstate CHAR(5);
  DECLARE caught_errno INT;
  DECLARE caught_constraint VARCHAR(64);
  DECLARE caught_message VARCHAR(512);
  DECLARE diagnostic_count INT;
  DECLARE rejection_count INT DEFAULT 0;
  DECLARE first_user_id BIGINT;
  DECLARE replacement_user_id BIGINT;
  DECLARE cascade_user_id BIGINT;
  DECLARE remaining_cascade_rows INT;
  DECLARE test_now DATETIME(6);

  -- Only the two expected data-error classes are continued. A syntax, permission,
  -- connection, or unexpected data error falls through to the EXIT handler.
  DECLARE CONTINUE HANDLER FOR SQLSTATE '23000'
  BEGIN
    GET DIAGNOSTICS diagnostic_count = NUMBER;
    GET DIAGNOSTICS CONDITION diagnostic_count
      caught_sqlstate = RETURNED_SQLSTATE,
      caught_errno = MYSQL_ERRNO,
      caught_constraint = CONSTRAINT_NAME,
      caught_message = MESSAGE_TEXT;
    IF expected_sqlstate IS NULL OR expected_sqlstate <> '23000' THEN
      RESIGNAL;
    END IF;
    IF caught_sqlstate <> expected_sqlstate
      OR caught_errno IS NULL
      OR caught_errno <= 0
      OR caught_message IS NULL
      OR caught_message = '' THEN
      SET caught_message = CONCAT(
        'integrity diagnostics #',
        rejection_count + 1,
        ' state=',
        COALESCE(caught_sqlstate, '<NULL>'),
        ' errno=',
        COALESCE(CAST(caught_errno AS CHAR), '<NULL>')
      );
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = caught_message;
    END IF;
    SET rejected = TRUE;
    SET rejection_count = rejection_count + 1;
  END;

  DECLARE CONTINUE HANDLER FOR SQLSTATE '22007'
  BEGIN
    GET DIAGNOSTICS diagnostic_count = NUMBER;
    GET DIAGNOSTICS CONDITION diagnostic_count
      caught_sqlstate = RETURNED_SQLSTATE,
      caught_errno = MYSQL_ERRNO,
      caught_constraint = CONSTRAINT_NAME,
      caught_message = MESSAGE_TEXT;
    IF expected_sqlstate IS NULL OR expected_sqlstate <> '22007' THEN
      RESIGNAL;
    END IF;
    IF caught_sqlstate <> expected_sqlstate
      OR caught_errno IS NULL
      OR caught_errno <= 0
      OR caught_message IS NULL
      OR caught_message = '' THEN
      SET caught_message = CONCAT(
        'UUID diagnostics #',
        rejection_count + 1,
        ' state=',
        COALESCE(caught_sqlstate, '<NULL>'),
        ' errno=',
        COALESCE(CAST(caught_errno AS CHAR), '<NULL>')
      );
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = caught_message;
    END IF;
    SET rejected = TRUE;
    SET rejection_count = rejection_count + 1;
  END;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;
  SET test_now = UTC_TIMESTAMP(6);

  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('phase1@example.invalid', '검증 사용자', 'argon2-synthetic-placeholder');
  SET first_user_id = LAST_INSERT_ID();

  -- Rejection 01: only active users share the email uniqueness key.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('phase1@example.invalid', '중복 사용자', 'argon2-synthetic-placeholder');
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'active email uniqueness was not enforced';
  END IF;

  UPDATE users
  SET deleted_at = UTC_TIMESTAMP(6), is_active = FALSE
  WHERE id = first_user_id;
  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('phase1@example.invalid', '대체 사용자', 'argon2-synthetic-placeholder');
  SET replacement_user_id = LAST_INSERT_ID();

  -- Rejection 02: normalized email is lowercase.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('upper@EXAMPLE.invalid', '대문자 메일', 'argon2-synthetic-placeholder');
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'email normalization check was not enforced';
  END IF;

  -- Rejection 03: PAD SPACE collation must not weaken trim equality.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('padded@example.invalid ', '후행 공백 메일', 'argon2-synthetic-placeholder');
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'email trailing whitespace was not rejected';
  END IF;

  -- Rejection 04: display names preserve the PostgreSQL trim invariant.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('padded-name@example.invalid', '후행 공백 ', 'argon2-synthetic-placeholder');
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'display-name trailing whitespace was not rejected';
  END IF;

  -- Rejection 05: anonymization cannot precede soft deletion.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO users (
    email_normalized, display_name, password_hash, anonymized_at
  ) VALUES (
    'anonymized-before-delete@example.invalid',
    '잘못된 익명화',
    'argon2-synthetic-placeholder',
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'anonymization-before-delete was not rejected';
  END IF;

  -- Rejection 06: failed-login counters cannot become negative.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO users (
    email_normalized, display_name, password_hash, failed_login_attempts
  ) VALUES (
    'negative-login-count@example.invalid',
    '음수 로그인',
    'argon2-synthetic-placeholder',
    -1
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'negative failed-login count was not rejected';
  END IF;

  -- The complementary valid state must remain writable: anonymization follows deletion.
  UPDATE users
  SET anonymized_at = test_now
  WHERE id = first_user_id AND deleted_at IS NOT NULL;
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'valid post-delete anonymization was not accepted';
  END IF;

  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at, ip_address
  ) VALUES (
    replacement_user_id, 'terms', 'synthetic-v1', UTC_TIMESTAMP(6), '2001:db8::1'
  );

  -- Rejection 07: consent identity is unique per user/type/policy version.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at, ip_address
  ) VALUES (
    replacement_user_id, 'terms', 'synthetic-v1', test_now, '2001:db8::1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consent identity uniqueness was not enforced';
  END IF;

  -- Rejection 08: malformed address text is rejected.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at, ip_address
  ) VALUES (
    replacement_user_id, 'privacy', 'synthetic-v1', test_now, 'not-an-ip'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IP address validation was not enforced';
  END IF;

  -- Rejection 09: equivalent but non-canonical IP text is rejected.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at, ip_address
  ) VALUES (
    replacement_user_id,
    'privacy',
    'synthetic-v2',
    test_now,
    '2001:0db8:0:0:0:0:0:1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'non-canonical IP address was not rejected';
  END IF;

  -- Rejection 10: an active consent must retain its acceptance IP.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at
  ) VALUES (
    replacement_user_id, 'privacy', 'missing-ip-v1', test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'active consent without IP was not rejected';
  END IF;

  -- Rejection 11: withdrawn consent retention must end after withdrawal.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO user_consents (
    user_id,
    consent_type,
    policy_version,
    accepted_at,
    withdrawn_at,
    retention_expires_at
  ) VALUES (
    replacement_user_id,
    'age_over_14',
    'invalid-retention-v1',
    test_now,
    test_now + INTERVAL 1 HOUR,
    test_now + INTERVAL 30 MINUTE
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid withdrawn-consent retention was not rejected';
  END IF;

  -- The complementary withdrawn state drops the IP and keeps a future retention boundary.
  INSERT INTO user_consents (
    user_id,
    consent_type,
    policy_version,
    accepted_at,
    withdrawn_at,
    retention_expires_at
  ) VALUES (
    replacement_user_id,
    'privacy',
    'withdrawn-v1',
    test_now - INTERVAL 2 HOUR,
    test_now - INTERVAL 1 HOUR,
    test_now + INTERVAL 1 DAY
  );

  -- Rejection 12: consent rows cannot reference a missing user.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at, ip_address
  ) VALUES (
    9223372036854775807, 'terms', 'orphan-v1', test_now, '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'orphan consent was not rejected';
  END IF;

  INSERT INTO email_verification_tokens (
    user_id, token_hash, expires_at
  ) VALUES (
    replacement_user_id, UNHEX(REPEAT('11', 32)), UTC_TIMESTAMP(6) + INTERVAL 1 DAY
  );

  -- Rejection 13: only one email-verification token remains open per user.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO email_verification_tokens (
    user_id, token_hash, expires_at
  ) VALUES (
    replacement_user_id, UNHEX(REPEAT('12', 32)), test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'one-open-email-token rule was not enforced';
  END IF;

  UPDATE email_verification_tokens
  SET used_at = UTC_TIMESTAMP(6)
  WHERE user_id = replacement_user_id AND used_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO email_verification_tokens (
    user_id, token_hash, expires_at
  ) VALUES (
    replacement_user_id, UNHEX(REPEAT('12', 32)), test_now + INTERVAL 1 DAY
  );

  -- Rejection 14: used and invalidated are mutually exclusive terminal states.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO email_verification_tokens (
    user_id, token_hash, expires_at, used_at, invalidated_at, created_at
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('13', 32)),
    test_now + INTERVAL 1 DAY,
    test_now,
    test_now,
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'email-token terminal states were not enforced';
  END IF;

  -- Rejection 15: token expiry must be strictly after creation.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO email_verification_tokens (
    user_id, token_hash, expires_at, used_at, created_at
  ) VALUES (
    replacement_user_id, UNHEX(REPEAT('14', 32)), test_now, test_now, test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'email-token expiry was not enforced';
  END IF;

  -- Rejection 16: email token hashes remain exactly 32 bytes.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO email_verification_tokens (
    user_id, token_hash, expires_at, used_at, created_at
  ) VALUES (
    replacement_user_id, UNHEX('AA'), test_now + INTERVAL 1 DAY, test_now, test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'short email-token hash was not rejected';
  END IF;

  -- The second legal terminal state is invalidation rather than use.
  UPDATE email_verification_tokens
  SET invalidated_at = test_now
  WHERE user_id = replacement_user_id
    AND token_hash = UNHEX(REPEAT('12', 32))
    AND used_at IS NULL
    AND invalidated_at IS NULL;
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'valid email-token invalidation was not accepted';
  END IF;

  -- Rejection 17: password-reset token hashes remain exactly 32 bytes.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, requested_ip
  ) VALUES (
    replacement_user_id, UNHEX('AA'), test_now + INTERVAL 1 DAY, '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'short password-reset hash was not rejected';
  END IF;

  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, requested_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('21', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );

  -- Rejection 18: only one password-reset token remains open per user.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, requested_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('22', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'one-open-password-reset rule was not enforced';
  END IF;

  UPDATE password_reset_tokens
  SET used_at = test_now
  WHERE user_id = replacement_user_id AND used_at IS NULL AND invalidated_at IS NULL;
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, requested_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('22', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );

  -- Rejection 19: reset-token terminal states are mutually exclusive.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO password_reset_tokens (
    user_id,
    token_hash,
    expires_at,
    used_at,
    invalidated_at,
    requested_ip,
    created_at
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('23', 32)),
    test_now + INTERVAL 1 DAY,
    test_now,
    test_now,
    '127.0.0.1',
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'password-reset terminal states were not enforced';
  END IF;

  -- Rejection 20: reset-token expiry must be after creation.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, used_at, requested_ip, created_at
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('24', 32)),
    test_now,
    test_now,
    '127.0.0.1',
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'password-reset expiry was not enforced';
  END IF;

  -- Rejection 21: reset requests require a valid canonical IP.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, used_at, requested_ip, created_at
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('25', 32)),
    test_now + INTERVAL 1 DAY,
    test_now,
    'not-an-ip',
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid password-reset IP was not rejected';
  END IF;

  -- Rejection 22: reset request IP text must be canonical.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, used_at, requested_ip, created_at
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('26', 32)),
    test_now + INTERVAL 1 DAY,
    test_now,
    '2001:0db8:0:0:0:0:0:1',
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'non-canonical password-reset IP was not rejected';
  END IF;

  -- Password-reset invalidation is the other valid terminal state.
  UPDATE password_reset_tokens
  SET invalidated_at = test_now
  WHERE user_id = replacement_user_id
    AND token_hash = UNHEX(REPEAT('22', 32))
    AND used_at IS NULL
    AND invalidated_at IS NULL;
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'valid reset-token invalidation was not accepted';
  END IF;

  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('31', 32)),
    UNHEX(REPEAT('32', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );

  -- Rejection 23: session hashes are globally unique.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('31', 32)),
    UNHEX(REPEAT('33', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session hash uniqueness was not enforced';
  END IF;

  -- Rejection 24: session hashes remain exactly 32 bytes.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX('AA'),
    UNHEX(REPEAT('34', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'short session hash was not rejected';
  END IF;

  -- Rejection 25: CSRF hashes remain exactly 32 bytes.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('35', 32)),
    UNHEX('BB'),
    test_now + INTERVAL 1 DAY,
    '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'short CSRF hash was not rejected';
  END IF;

  -- Rejection 26: malformed session IP text is rejected.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('36', 32)),
    UNHEX(REPEAT('37', 32)),
    test_now + INTERVAL 1 DAY,
    'not-an-ip'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid session IP was not rejected';
  END IF;

  -- Rejection 27: session IP text must be canonical.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('38', 32)),
    UNHEX(REPEAT('39', 32)),
    test_now + INTERVAL 1 DAY,
    '2001:0db8:0:0:0:0:0:1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'non-canonical session IP was not rejected';
  END IF;

  -- Rejection 28: session expiry must be after issue time.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, issued_at, expires_at, created_ip
  ) VALUES (
    replacement_user_id,
    UNHEX(REPEAT('3A', 32)),
    UNHEX(REPEAT('3B', 32)),
    test_now,
    test_now,
    '127.0.0.1'
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session expiry was not enforced';
  END IF;

  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/synthetic',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b101',
    UNHEX(REPEAT('44', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    UTC_TIMESTAMP(6) + INTERVAL 1 DAY
  );

  -- Rejection 29: actor/route/idempotency UUID identity is unique.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/synthetic',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b101',
    UNHEX(REPEAT('45', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'idempotency identity uniqueness was not enforced';
  END IF;

  -- Rejection 30: idempotency request hashes remain exactly 32 bytes.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/short-request-hash',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b103',
    UNHEX('CC'),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'short idempotency request hash was not rejected';
  END IF;

  -- Rejection 31: only successful HTTP statuses may be cached.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/invalid-status',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b104',
    UNHEX(REPEAT('46', 32)),
    399,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid idempotency status was not rejected';
  END IF;

  -- Rejection 32: idempotency expiry must be after creation.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    created_at,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/invalid-expiry',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b105',
    UNHEX(REPEAT('47', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now,
    test_now
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'idempotency expiry was not enforced';
  END IF;

  -- Rejection 33: route keys cannot be blank after trimming.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    '   ',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b106',
    UNHEX(REPEAT('48', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'blank idempotency route was not rejected';
  END IF;

  -- Rejection 34: native UUID rejects malformed values with a data exception.
  SET rejected = FALSE;
  SET expected_sqlstate = '22007';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/invalid-uuid',
    'not-a-uuid',
    UNHEX(REPEAT('49', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid UUID was not rejected';
  END IF;

  -- Rejection 35: JSON alias and its named CHECK both reject invalid JSON.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    replacement_user_id,
    'POST /api/v1/invalid-json',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b107',
    UNHEX(REPEAT('4A', 32)),
    201,
    '{invalid',
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid JSON was not rejected';
  END IF;

  -- Rejection 36: idempotency rows cannot reference a missing actor.
  SET rejected = FALSE;
  SET expected_sqlstate = '23000';
  SET caught_sqlstate = NULL;
  SET caught_errno = NULL;
  SET caught_constraint = NULL;
  SET caught_message = NULL;
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    9223372036854775807,
    'POST /api/v1/orphan',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b108',
    UNHEX(REPEAT('4B', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );
  SET expected_sqlstate = NULL;
  IF rejected = FALSE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'orphan idempotency actor was not rejected';
  END IF;

  -- Every phase-1 child table must be removed by the users ON DELETE CASCADE.
  INSERT INTO users (email_normalized, display_name, password_hash)
  VALUES ('cascade@example.invalid', '연쇄 삭제', 'argon2-synthetic-placeholder');
  SET cascade_user_id = LAST_INSERT_ID();

  INSERT INTO user_consents (
    user_id, consent_type, policy_version, accepted_at, ip_address
  ) VALUES (
    cascade_user_id, 'terms', 'cascade-v1', test_now, '127.0.0.2'
  );
  INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
  VALUES (
    cascade_user_id, UNHEX(REPEAT('A1', 32)), test_now + INTERVAL 1 DAY
  );
  INSERT INTO password_reset_tokens (
    user_id, token_hash, expires_at, requested_ip
  ) VALUES (
    cascade_user_id,
    UNHEX(REPEAT('A2', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.2'
  );
  INSERT INTO sessions (
    user_id, session_hash, csrf_token_hash, expires_at, created_ip
  ) VALUES (
    cascade_user_id,
    UNHEX(REPEAT('A3', 32)),
    UNHEX(REPEAT('A4', 32)),
    test_now + INTERVAL 1 DAY,
    '127.0.0.2'
  );
  INSERT INTO api_idempotency_keys (
    actor_user_id,
    route_key,
    idempotency_key,
    request_hash,
    response_status,
    response_body_json,
    expires_at
  ) VALUES (
    cascade_user_id,
    'POST /api/v1/cascade',
    '018f0f8b-88f7-7f8d-9a1f-1f4a41e5b201',
    UNHEX(REPEAT('A5', 32)),
    201,
    JSON_OBJECT('ok', TRUE),
    test_now + INTERVAL 1 DAY
  );

  DELETE FROM users WHERE id = cascade_user_id;

  SELECT
    (SELECT COUNT(*) FROM users WHERE id = cascade_user_id)
    + (SELECT COUNT(*) FROM user_consents WHERE user_id = cascade_user_id)
    + (SELECT COUNT(*) FROM email_verification_tokens WHERE user_id = cascade_user_id)
    + (SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = cascade_user_id)
    + (SELECT COUNT(*) FROM sessions WHERE user_id = cascade_user_id)
    + (SELECT COUNT(*) FROM api_idempotency_keys WHERE actor_user_id = cascade_user_id)
    INTO remaining_cascade_rows;
  IF remaining_cascade_rows <> 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'phase-1 user cascade was incomplete';
  END IF;

  IF rejection_count <> 36 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'semantic rejection count was incomplete';
  END IF;

  ROLLBACK;
  SELECT 'pass' AS identity_foundation_semantics;
END//
DELIMITER ;

CALL classhub_verify_identity_foundation();
DROP PROCEDURE classhub_verify_identity_foundation;
