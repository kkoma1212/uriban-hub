-- Up Migration

/*
 * 관리자 웹 계정은 학생·교사 users와 운영 CLI operators 어느 쪽에도 섞지 않는다.
 * 전자는 제품 사용자이고 후자는 비상 운영 자격증명이므로, 수명과 권한 경계가 다르다.
 */
CREATE TABLE admin_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_input_version TEXT NOT NULL DEFAULT 'nfc_v1',
  status TEXT NOT NULL DEFAULT 'pending_mfa',
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_last_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_operator_id BIGINT NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_accounts_email_check CHECK (
    email_normalized = lower(btrim(email_normalized))
    AND email_normalized <> ''
  ),
  CONSTRAINT admin_accounts_display_name_check CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 2 AND 40
    AND display_name !~ '[[:cntrl:]]'
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
);

CREATE TABLE admin_account_roles (
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  granted_by_operator_id BIGINT NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (admin_account_id, role),
  CONSTRAINT admin_account_roles_role_check CHECK (
    role IN ('super_admin', 'account_manager', 'support', 'security_auditor')
  )
);

/*
 * TOTP 비밀은 평문으로 보관하지 않는다. AES-256-GCM의 ciphertext·IV·tag와
 * 키 버전만 저장하며, 실제 키는 환경 비밀에서 주입한다.
 */
CREATE TABLE admin_mfa_factors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  factor_type TEXT NOT NULL DEFAULT 'totp',
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_accepted_timestep BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  activated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT admin_mfa_factors_type_check CHECK (factor_type = 'totp'),
  CONSTRAINT admin_mfa_factors_ciphertext_check CHECK (
    octet_length(secret_ciphertext) BETWEEN 1 AND 256
  ),
  CONSTRAINT admin_mfa_factors_iv_check CHECK (octet_length(secret_iv) = 12),
  CONSTRAINT admin_mfa_factors_auth_tag_check CHECK (octet_length(secret_auth_tag) = 16),
  CONSTRAINT admin_mfa_factors_key_version_check CHECK (
    key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
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
);

CREATE UNIQUE INDEX admin_mfa_factors_one_current_per_account
  ON admin_mfa_factors (admin_account_id)
  WHERE revoked_at IS NULL;

/*
 * 비밀번호 1차 인증과 TOTP 2차 인증 사이의 짧은 상태다. 브라우저에는 원본을,
 * DB에는 SHA-256 해시만 둔다. 실패 횟수는 표 안에서도 최대 5회로 제한한다.
 */
CREATE TABLE admin_login_challenges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  challenge_hash BYTEA NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_login_challenges_hash_check CHECK (octet_length(challenge_hash) = 32),
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
);

CREATE INDEX admin_login_challenges_account_index
  ON admin_login_challenges (admin_account_id, consumed_at, expires_at);

/*
 * 관리자 세션은 일반 사용자 세션과 쿠키까지 분리한다. 절대 만료는 8시간,
 * 비활성 만료는 API가 last_seen_at 기준 30분으로 판정한다.
 */
CREATE TABLE admin_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  session_hash BYTEA NOT NULL UNIQUE,
  csrf_token_hash BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  mfa_verified_at TIMESTAMPTZ NOT NULL,
  reauthenticated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_ip_hmac TEXT NOT NULL,
  hmac_key_version TEXT NOT NULL,
  user_agent TEXT,
  CONSTRAINT admin_sessions_session_hash_check CHECK (octet_length(session_hash) = 32),
  CONSTRAINT admin_sessions_csrf_hash_check CHECK (octet_length(csrf_token_hash) = 32),
  CONSTRAINT admin_sessions_time_order_check CHECK (
    last_seen_at >= issued_at
    AND absolute_expires_at > issued_at
    AND mfa_verified_at >= issued_at
    AND mfa_verified_at <= absolute_expires_at
    AND (reauthenticated_at IS NULL OR reauthenticated_at >= issued_at)
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
  ),
  CONSTRAINT admin_sessions_ip_hmac_check CHECK (
    created_ip_hmac ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT admin_sessions_hmac_key_version_check CHECK (
    hmac_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  CONSTRAINT admin_sessions_user_agent_check CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 512
  )
);

CREATE INDEX admin_sessions_account_active_index
  ON admin_sessions (admin_account_id, revoked_at, absolute_expires_at);

/*
 * 인증 감사에는 비밀번호·TOTP 코드·TOTP 비밀·원본 IP·원본 이메일을 넣지 않는다.
 * 애플리케이션 역할에는 INSERT만 주어 기록을 고치거나 지울 수 없게 한다.
 */
CREATE TABLE admin_auth_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  admin_account_id BIGINT REFERENCES admin_accounts (id) ON DELETE SET NULL,
  actor_email_hmac TEXT,
  actor_ip_hmac TEXT,
  hmac_key_version TEXT,
  action TEXT NOT NULL,
  deny_reason TEXT,
  request_id UUID NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_auth_audit_logs_action_check CHECK (action IN (
    'admin.auth.login_failed', 'admin.auth.password_verified',
    'admin.auth.mfa_enrolled', 'admin.auth.login_succeeded',
    'admin.auth.logout', 'admin.auth.session_expired',
    'admin.auth.step_up_failed', 'admin.auth.step_up_succeeded'
  )),
  CONSTRAINT admin_auth_audit_logs_email_hmac_check CHECK (
    actor_email_hmac IS NULL OR actor_email_hmac ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT admin_auth_audit_logs_ip_hmac_check CHECK (
    actor_ip_hmac IS NULL OR actor_ip_hmac ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT admin_auth_audit_logs_hmac_pair_check CHECK (
    ((actor_email_hmac IS NULL AND actor_ip_hmac IS NULL) AND hmac_key_version IS NULL)
    OR ((actor_email_hmac IS NOT NULL OR actor_ip_hmac IS NOT NULL) AND hmac_key_version IS NOT NULL)
  ),
  CONSTRAINT admin_auth_audit_logs_deny_reason_check CHECK (
    deny_reason IS NULL OR (
      deny_reason = btrim(deny_reason)
      AND char_length(deny_reason) BETWEEN 1 AND 80
    )
  ),
  CONSTRAINT admin_auth_audit_logs_user_agent_check CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 512
  )
);

CREATE INDEX admin_auth_audit_logs_created_index
  ON admin_auth_audit_logs (created_at);

ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.password_reset', 'teacher.transferred', 'teacher.revoked',
    'admin.created', 'class.suspended', 'class.archived', 'class.reactivated',
    'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'holiday.imported',
    'retention.executed', 'reminder.executed', 'job.failed'
  )),
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['operator_id', 'status'])
        AND jsonb_has_only_keys(after_json, ARRAY['operator_id', 'status'])
      WHEN action LIKE 'teacher.%' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
      WHEN action = 'admin.created' THEN
        jsonb_has_only_keys(
          before_json, ARRAY['admin_account_id', 'admin_account_status', 'role']
        )
        AND jsonb_has_only_keys(
          after_json, ARRAY['admin_account_id', 'admin_account_status', 'role']
        )
      WHEN action LIKE 'class.%' THEN
        jsonb_has_only_keys(
          before_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
      WHEN action LIKE 'user.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['user_id', 'is_active', 'reason'])
        AND jsonb_has_only_keys(after_json, ARRAY['user_id', 'is_active', 'reason'])
      WHEN action IN (
        'school.imported',
        'meal.imported',
        'school_schedule.imported',
        'holiday.imported'
      ) THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
      WHEN action = 'reminder.executed' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
      WHEN action = 'job.failed' THEN
        jsonb_has_only_keys(before_json, ARRAY['job_name', 'error_name'])
        AND jsonb_has_only_keys(after_json, ARRAY['job_name', 'error_name'])
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  );

REVOKE ALL PRIVILEGES ON
  admin_accounts, admin_account_roles, admin_mfa_factors,
  admin_login_challenges, admin_sessions, admin_auth_audit_logs
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  admin_accounts_id_seq, admin_mfa_factors_id_seq,
  admin_login_challenges_id_seq, admin_sessions_id_seq,
  admin_auth_audit_logs_id_seq
FROM PUBLIC;

GRANT SELECT ON admin_accounts TO classhub_app;
GRANT UPDATE (
  failed_login_attempts, locked_until, last_login_at, status, updated_at
) ON admin_accounts TO classhub_app;
GRANT SELECT ON admin_account_roles TO classhub_app;
GRANT SELECT ON admin_mfa_factors, admin_login_challenges, admin_sessions TO classhub_app;
GRANT INSERT (
  admin_account_id, factor_type, secret_ciphertext, secret_iv,
  secret_auth_tag, key_version, status, last_accepted_timestep,
  activated_at, revoked_at
) ON admin_mfa_factors TO classhub_app;
GRANT UPDATE (
  status, last_accepted_timestep, activated_at, revoked_at
) ON admin_mfa_factors TO classhub_app;
GRANT INSERT (
  admin_account_id, challenge_hash, purpose, failed_attempts,
  expires_at, consumed_at
) ON admin_login_challenges TO classhub_app;
GRANT UPDATE (failed_attempts, consumed_at) ON admin_login_challenges TO classhub_app;
GRANT INSERT (
  admin_account_id, session_hash, csrf_token_hash, issued_at, last_seen_at,
  absolute_expires_at, mfa_verified_at, reauthenticated_at, revoked_at,
  created_ip_hmac, hmac_key_version, user_agent
) ON admin_sessions TO classhub_app;
GRANT UPDATE (last_seen_at, reauthenticated_at, revoked_at) ON admin_sessions TO classhub_app;
GRANT INSERT (
  event_id, admin_account_id, actor_email_hmac, actor_ip_hmac,
  hmac_key_version, action, deny_reason, request_id, user_agent
) ON admin_auth_audit_logs TO classhub_app;
GRANT USAGE ON SEQUENCE
  admin_mfa_factors_id_seq, admin_login_challenges_id_seq,
  admin_sessions_id_seq, admin_auth_audit_logs_id_seq
TO classhub_app;

GRANT SELECT ON admin_accounts, admin_account_roles TO classhub_operator;
GRANT INSERT (
  email_normalized, display_name, password_hash, password_input_version,
  created_by_operator_id
) ON admin_accounts TO classhub_operator;
GRANT INSERT (
  admin_account_id, role, granted_by_operator_id
) ON admin_account_roles TO classhub_operator;
GRANT USAGE ON SEQUENCE admin_accounts_id_seq TO classhub_operator;

GRANT SELECT, DELETE ON
  admin_login_challenges, admin_sessions, admin_auth_audit_logs
TO classhub_retention;

-- Down Migration

DO $admin_auth_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_accounts) THEN
    RAISE EXCEPTION
      'admin_accounts still holds rows; '
      'export and remove administrator authentication data before rolling back';
  END IF;

  IF EXISTS (SELECT 1 FROM operator_audit_logs WHERE action = 'admin.created') THEN
    RAISE EXCEPTION
      'operator_audit_logs still holds admin.created rows; '
      'remove or migrate them before rolling back';
  END IF;
END
$admin_auth_rollback_guard$;

REVOKE SELECT, DELETE ON
  admin_login_challenges, admin_sessions, admin_auth_audit_logs
FROM classhub_retention;
REVOKE USAGE ON SEQUENCE admin_accounts_id_seq FROM classhub_operator;
REVOKE INSERT (admin_account_id, role, granted_by_operator_id)
  ON admin_account_roles FROM classhub_operator;
REVOKE INSERT (
  email_normalized, display_name, password_hash, password_input_version,
  created_by_operator_id
) ON admin_accounts FROM classhub_operator;
REVOKE SELECT ON admin_accounts, admin_account_roles FROM classhub_operator;
REVOKE USAGE ON SEQUENCE
  admin_mfa_factors_id_seq, admin_login_challenges_id_seq,
  admin_sessions_id_seq, admin_auth_audit_logs_id_seq
FROM classhub_app;
REVOKE INSERT (
  event_id, admin_account_id, actor_email_hmac, actor_ip_hmac,
  hmac_key_version, action, deny_reason, request_id, user_agent
) ON admin_auth_audit_logs FROM classhub_app;
REVOKE UPDATE (last_seen_at, reauthenticated_at, revoked_at)
  ON admin_sessions FROM classhub_app;
REVOKE INSERT (
  admin_account_id, session_hash, csrf_token_hash, issued_at, last_seen_at,
  absolute_expires_at, mfa_verified_at, reauthenticated_at, revoked_at,
  created_ip_hmac, hmac_key_version, user_agent
) ON admin_sessions FROM classhub_app;
REVOKE UPDATE (failed_attempts, consumed_at)
  ON admin_login_challenges FROM classhub_app;
REVOKE INSERT (
  admin_account_id, challenge_hash, purpose, failed_attempts,
  expires_at, consumed_at
) ON admin_login_challenges FROM classhub_app;
REVOKE UPDATE (status, last_accepted_timestep, activated_at, revoked_at)
  ON admin_mfa_factors FROM classhub_app;
REVOKE INSERT (
  admin_account_id, factor_type, secret_ciphertext, secret_iv,
  secret_auth_tag, key_version, status, last_accepted_timestep,
  activated_at, revoked_at
) ON admin_mfa_factors FROM classhub_app;
REVOKE SELECT ON admin_mfa_factors, admin_login_challenges, admin_sessions FROM classhub_app;
REVOKE SELECT ON admin_account_roles FROM classhub_app;
REVOKE UPDATE (
  failed_login_attempts, locked_until, last_login_at, status, updated_at
) ON admin_accounts FROM classhub_app;
REVOKE SELECT ON admin_accounts FROM classhub_app;

ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.password_reset', 'teacher.transferred', 'teacher.revoked',
    'class.suspended', 'class.archived', 'class.reactivated',
    'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'holiday.imported',
    'retention.executed', 'reminder.executed', 'job.failed'
  )),
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['operator_id', 'status'])
        AND jsonb_has_only_keys(after_json, ARRAY['operator_id', 'status'])
      WHEN action LIKE 'teacher.%' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
      WHEN action LIKE 'class.%' THEN
        jsonb_has_only_keys(
          before_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
      WHEN action LIKE 'user.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['user_id', 'is_active', 'reason'])
        AND jsonb_has_only_keys(after_json, ARRAY['user_id', 'is_active', 'reason'])
      WHEN action IN (
        'school.imported',
        'meal.imported',
        'school_schedule.imported',
        'holiday.imported'
      ) THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
      WHEN action = 'reminder.executed' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
      WHEN action = 'job.failed' THEN
        jsonb_has_only_keys(before_json, ARRAY['job_name', 'error_name'])
        AND jsonb_has_only_keys(after_json, ARRAY['job_name', 'error_name'])
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  );

DROP TABLE admin_auth_audit_logs;
DROP TABLE admin_sessions;
DROP TABLE admin_login_challenges;
DROP TABLE admin_mfa_factors;
DROP TABLE admin_account_roles;
DROP TABLE admin_accounts;
