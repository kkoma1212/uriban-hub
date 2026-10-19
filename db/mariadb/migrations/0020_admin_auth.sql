-- T-HUB-64 phase 0020. Isolated synthetic development only; runtime ACLs remain separate.
-- PostgreSQL source: 1783700041000_admin-auth-foundation.sql (Up only).
-- AUTO_INCREMENT is not GENERATED ALWAYS identity; runtime column permissions remain an activation gate.
-- NOPAD preserves significant spaces; absolute PCRE anchors reject a trailing newline.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE admin_accounts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email_normalized LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL UNIQUE,
  display_name LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  password_hash LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  password_input_version LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'nfc_v1',
  status LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'pending_mfa',
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME(6),
  password_last_changed_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  created_by_operator_id BIGINT NOT NULL,
  CONSTRAINT admin_accounts_created_by_operator_id_fk FOREIGN KEY (created_by_operator_id) REFERENCES operators (id) ON DELETE RESTRICT,
  last_login_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT admin_accounts_email_check CHECK (
    BINARY email_normalized = BINARY LOWER(TRIM(email_normalized))
    AND email_normalized <> ''
  ),
  CONSTRAINT admin_accounts_display_name_check CHECK (
    BINARY display_name = BINARY TRIM(display_name)
    AND CHAR_LENGTH(display_name) BETWEEN 2 AND 40
    AND display_name NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT admin_accounts_password_hash_check CHECK (password_hash <> ''),
  CONSTRAINT admin_accounts_password_input_version_check CHECK (
    password_input_version = 'nfc_v1'
  ),
  CONSTRAINT admin_accounts_status_check CHECK (
    status IN ('pending_mfa', 'active', 'suspended', 'revoked')
  ),
  CONSTRAINT admin_accounts_failed_login_attempts_check CHECK (failed_login_attempts >= 0),
  CONSTRAINT admin_accounts_lock_state_check CHECK (
    status <> 'revoked' OR locked_until IS NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE admin_account_roles (
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_account_roles_admin_account_id_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  role VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL,
  granted_by_operator_id BIGINT NOT NULL,
  CONSTRAINT admin_account_roles_granted_by_operator_id_fk FOREIGN KEY (granted_by_operator_id) REFERENCES operators (id) ON DELETE RESTRICT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (admin_account_id, role),
  CONSTRAINT admin_account_roles_role_check CHECK (
    role IN ('super_admin', 'account_manager', 'support', 'security_auditor')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;


CREATE TABLE admin_mfa_factors (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_mfa_factors_admin_account_id_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  factor_type LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'totp',
  secret_ciphertext VARBINARY(256) NOT NULL,
  secret_iv VARBINARY(12) NOT NULL,
  secret_auth_tag VARBINARY(16) NOT NULL,
  key_version LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  status LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'pending',
  last_accepted_timestep BIGINT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  activated_at DATETIME(6),
  revoked_at DATETIME(6),
  -- Source partial UNIQUE projects only non-revoked factors.
  current_admin_account_id BIGINT GENERATED ALWAYS AS (
    CASE WHEN revoked_at IS NULL THEN admin_account_id ELSE NULL END
  ) STORED,
  CONSTRAINT admin_mfa_factors_type_check CHECK (factor_type = 'totp'),
  CONSTRAINT admin_mfa_factors_ciphertext_check CHECK (
    OCTET_LENGTH(secret_ciphertext) BETWEEN 1 AND 256
  ),
  CONSTRAINT admin_mfa_factors_iv_check CHECK (OCTET_LENGTH(secret_iv) = 12),
  CONSTRAINT admin_mfa_factors_auth_tag_check CHECK (OCTET_LENGTH(secret_auth_tag) = 16),
  CONSTRAINT admin_mfa_factors_key_version_check CHECK (
    BINARY key_version REGEXP '\\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z'
  ),
  CONSTRAINT admin_mfa_factors_status_check CHECK (
    status IN ('pending', 'active', 'revoked')
  ),
  CONSTRAINT admin_mfa_factors_timestep_check CHECK (
    last_accepted_timestep IS NULL OR last_accepted_timestep >= 0
  ),
  CONSTRAINT admin_mfa_factors_state_check CHECK (
    (status = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE UNIQUE INDEX admin_mfa_factors_one_current_per_account
  ON admin_mfa_factors (current_admin_account_id);


CREATE TABLE admin_login_challenges (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_login_challenges_admin_account_id_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  challenge_hash VARBINARY(32) NOT NULL UNIQUE,
  purpose LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT admin_login_challenges_hash_check CHECK (OCTET_LENGTH(challenge_hash) = 32),
  CONSTRAINT admin_login_challenges_purpose_check CHECK (
    purpose IN ('enroll_totp', 'verify_totp')
  ),
  CONSTRAINT admin_login_challenges_attempts_check CHECK (
    failed_attempts BETWEEN 0 AND 5
  ),
  CONSTRAINT admin_login_challenges_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT admin_login_challenges_consumed_check CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX admin_login_challenges_account_index
  ON admin_login_challenges (admin_account_id, consumed_at, expires_at);


CREATE TABLE admin_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_sessions_admin_account_id_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  session_hash VARBINARY(32) NOT NULL UNIQUE,
  csrf_token_hash VARBINARY(32) NOT NULL,
  issued_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  last_seen_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  absolute_expires_at DATETIME(6) NOT NULL,
  mfa_verified_at DATETIME(6) NOT NULL,
  reauthenticated_at DATETIME(6),
  revoked_at DATETIME(6),
  created_ip_hmac LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  hmac_key_version LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  user_agent LONGTEXT COLLATE utf8mb4_nopad_bin,
  CONSTRAINT admin_sessions_session_hash_check CHECK (OCTET_LENGTH(session_hash) = 32),
  CONSTRAINT admin_sessions_csrf_hash_check CHECK (OCTET_LENGTH(csrf_token_hash) = 32),
  CONSTRAINT admin_sessions_time_order_check CHECK (
    last_seen_at >= issued_at
    AND absolute_expires_at > issued_at
    AND mfa_verified_at >= issued_at
    AND mfa_verified_at <= absolute_expires_at
    AND (reauthenticated_at IS NULL OR reauthenticated_at >= issued_at)
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
  ),
  CONSTRAINT admin_sessions_ip_hmac_check CHECK (
    BINARY created_ip_hmac REGEXP '\\A[A-Za-z0-9_-]{43}\\z'
  ),
  CONSTRAINT admin_sessions_hmac_key_version_check CHECK (
    BINARY hmac_key_version REGEXP '\\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z'
  ),
  CONSTRAINT admin_sessions_user_agent_check CHECK (
    user_agent IS NULL OR CHAR_LENGTH(user_agent) <= 512
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX admin_sessions_account_active_index
  ON admin_sessions (admin_account_id, revoked_at, absolute_expires_at);


CREATE TABLE admin_auth_audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  admin_account_id BIGINT,
  CONSTRAINT admin_auth_audit_logs_admin_account_id_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE SET NULL,
  actor_email_hmac LONGTEXT COLLATE utf8mb4_nopad_bin,
  actor_ip_hmac LONGTEXT COLLATE utf8mb4_nopad_bin,
  hmac_key_version LONGTEXT COLLATE utf8mb4_nopad_bin,
  action LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  deny_reason LONGTEXT COLLATE utf8mb4_nopad_bin,
  request_id UUID NOT NULL,
  user_agent LONGTEXT COLLATE utf8mb4_nopad_bin,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT admin_auth_audit_logs_action_check CHECK (action IN (
    'admin.auth.login_failed', 'admin.auth.password_verified',
    'admin.auth.mfa_enrolled', 'admin.auth.login_succeeded',
    'admin.auth.logout', 'admin.auth.session_expired',
    'admin.auth.step_up_failed', 'admin.auth.step_up_succeeded'
  )),
  CONSTRAINT admin_auth_audit_logs_email_hmac_check CHECK (
    actor_email_hmac IS NULL OR BINARY actor_email_hmac REGEXP '\\A[A-Za-z0-9_-]{43}\\z'
  ),
  CONSTRAINT admin_auth_audit_logs_ip_hmac_check CHECK (
    actor_ip_hmac IS NULL OR BINARY actor_ip_hmac REGEXP '\\A[A-Za-z0-9_-]{43}\\z'
  ),
  CONSTRAINT admin_auth_audit_logs_hmac_pair_check CHECK (
    ((actor_email_hmac IS NULL AND actor_ip_hmac IS NULL) AND hmac_key_version IS NULL)
    OR ((actor_email_hmac IS NOT NULL OR actor_ip_hmac IS NOT NULL) AND hmac_key_version IS NOT NULL)
  ),
  CONSTRAINT admin_auth_audit_logs_deny_reason_check CHECK (
    deny_reason IS NULL OR (
      BINARY deny_reason = BINARY TRIM(deny_reason)
      AND CHAR_LENGTH(deny_reason) BETWEEN 1 AND 80
    )
  ),
  CONSTRAINT admin_auth_audit_logs_user_agent_check CHECK (
    user_agent IS NULL OR CHAR_LENGTH(user_agent) <= 512
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX admin_auth_audit_logs_created_index
  ON admin_auth_audit_logs (created_at);

ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'operator.bootstrapped',
      BINARY 'operator.created',
      BINARY 'operator.revoked',
      BINARY 'operator.token_rotated',
      BINARY 'operator.credential_recovered',
      BINARY 'teacher.created',
      BINARY 'admin.created',
      BINARY 'teacher.password_reset',
      BINARY 'teacher.transferred',
      BINARY 'teacher.revoked',
      BINARY 'class.suspended',
      BINARY 'class.archived',
      BINARY 'class.reactivated',
      BINARY 'user.deactivated',
      BINARY 'user.reactivated',
      BINARY 'school.imported',
      BINARY 'meal.imported',
      BINARY 'school_schedule.imported',
      BINARY 'holiday.imported',
      BINARY 'retention.executed',
      BINARY 'reminder.executed',
      BINARY 'job.failed'
    )
  ),
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["operator_id","status"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["operator_id","status"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action LIKE 'teacher.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["teacher_user_id","teacher_profile_status","class_id","reason"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["teacher_user_id","teacher_profile_status","class_id","reason"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action = 'admin.created' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["admin_account_id","admin_account_status","role"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["admin_account_id","admin_account_status","role"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action LIKE 'class.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["class_id","status","teacher_user_id","reason"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["class_id","status","teacher_user_id","reason"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action LIKE 'user.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["user_id","is_active","reason"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["user_id","is_active","reason"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action IN ('school.imported', 'meal.imported', 'school_schedule.imported', 'holiday.imported') THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action = 'reminder.executed' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["eligible_count","sent_count","failed_count","window_ends_at"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["eligible_count","sent_count","failed_count","window_ends_at"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action = 'job.failed' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["job_name","error_name"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["job_name","error_name"]', JSON_KEYS(after_json)) = 1
        ))
      ELSE
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["cutoff_at","table_name","deleted_count"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["cutoff_at","table_name","deleted_count"]', JSON_KEYS(after_json)) = 1
        ))
    END
  );
