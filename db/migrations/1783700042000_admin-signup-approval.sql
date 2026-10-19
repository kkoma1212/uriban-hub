-- Up Migration
-- Raw approval codes are never stored. The keyed digest binds email, role and code.
ALTER TABLE users
  ADD COLUMN signup_approved_at TIMESTAMPTZ;

ALTER TABLE teacher_profiles
  ALTER COLUMN created_by_operator_id DROP NOT NULL,
  ADD COLUMN created_by_admin_account_id BIGINT
    REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  ADD CONSTRAINT teacher_profiles_creator_check CHECK (
    num_nonnulls(created_by_operator_id, created_by_admin_account_id) = 1
  );

CREATE TABLE admin_signup_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_key_digest BYTEA NOT NULL,
  role TEXT NOT NULL,
  code_digest BYTEA NOT NULL UNIQUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id BIGINT REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  issued_by_admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT admin_signup_approvals_email_digest_check CHECK (octet_length(email_key_digest) = 32),
  CONSTRAINT admin_signup_approvals_code_digest_check CHECK (octet_length(code_digest) = 32),
  CONSTRAINT admin_signup_approvals_role_check CHECK (role IN ('teacher', 'student')),
  CONSTRAINT admin_signup_approvals_attempts_check CHECK (failed_attempts BETWEEN 0 AND 5),
  CONSTRAINT admin_signup_approvals_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT admin_signup_approvals_terminal_check CHECK (num_nonnulls(consumed_at, revoked_at) <= 1),
  CONSTRAINT admin_signup_approvals_consumer_check CHECK (
    (consumed_at IS NULL AND consumed_by_user_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL AND revoked_at IS NULL)
  )
);
CREATE UNIQUE INDEX admin_signup_approvals_open_email_role_index
  ON admin_signup_approvals (email_key_digest, role)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE admin_signup_approval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID REFERENCES admin_signup_approvals (id) ON DELETE RESTRICT,
  admin_actor_account_id BIGINT REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  user_actor_id BIGINT REFERENCES users (id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  result_code TEXT NOT NULL,
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_signup_approval_events_role_check CHECK (role IN ('teacher', 'student')),
  CONSTRAINT admin_signup_approval_events_action_check CHECK (
    action IN ('issue', 'reissue', 'revoke', 'signup')
  ),
  CONSTRAINT admin_signup_approval_events_action_result_check CHECK (
    (action = 'issue' AND result_code = 'issued')
    OR (action = 'reissue' AND result_code = 'reissued')
    OR (action = 'revoke' AND result_code = 'revoked')
    OR (action = 'signup' AND result_code NOT IN ('issued', 'reissued', 'revoked'))
  ),
  CONSTRAINT admin_signup_approval_events_actor_check CHECK (
    (
      action IN ('issue', 'reissue', 'revoke')
      AND admin_actor_account_id IS NOT NULL
      AND user_actor_id IS NULL
      AND approval_id IS NOT NULL
    )
    OR
    (
      action = 'signup'
      AND result_code = 'approved'
      AND admin_actor_account_id IS NULL
      AND user_actor_id IS NOT NULL
      AND approval_id IS NOT NULL
    )
    OR
    (
      action = 'signup'
      AND result_code <> 'approved'
      AND admin_actor_account_id IS NULL
      AND user_actor_id IS NULL
    )
  ),
  CONSTRAINT admin_signup_approval_events_result_check CHECK (result_code IN (
    'issued',
    'reissued',
    'revoked',
    'approved',
    'approval_not_found',
    'approval_revoked',
    'approval_consumed',
    'approval_expired',
    'approval_attempts_exhausted',
    'approval_code_mismatch',
    'approval_state_changed',
    'email_unavailable'
  ))
);
CREATE INDEX admin_signup_approval_events_approval_index
  ON admin_signup_approval_events (approval_id, created_at DESC);
CREATE INDEX admin_signup_approval_events_created_index
  ON admin_signup_approval_events (created_at DESC, id DESC);

REVOKE ALL PRIVILEGES ON admin_signup_approvals FROM PUBLIC;
REVOKE ALL PRIVILEGES ON admin_signup_approval_events FROM PUBLIC;

GRANT SELECT ON admin_signup_approvals TO classhub_app;
GRANT INSERT (
  email_key_digest, role, code_digest, expires_at, issued_by_admin_account_id
) ON admin_signup_approvals TO classhub_app;
GRANT UPDATE (
  failed_attempts, consumed_at, consumed_by_user_id, revoked_at
) ON admin_signup_approvals TO classhub_app;
GRANT SELECT, INSERT ON admin_signup_approval_events TO classhub_app;
GRANT INSERT (
  user_id, status, temporary_password_must_change, temporary_password_expires_at,
  created_by_operator_id, created_by_admin_account_id
) ON teacher_profiles TO classhub_app;
GRANT USAGE ON SEQUENCE teacher_profiles_id_seq TO classhub_app;

-- Down Migration

DO $admin_signup_approval_rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teacher_profiles WHERE created_by_admin_account_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'teacher_profiles still holds admin-created profiles; migrate them before rolling back';
  END IF;

  IF EXISTS (SELECT 1 FROM admin_signup_approval_events) THEN
    RAISE EXCEPTION
      'admin_signup_approval_events still holds rows; preserve the audit trail before rolling back';
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE signup_approved_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'users still holds signup-approved accounts; migrate them before rolling back';
  END IF;

  IF EXISTS (SELECT 1 FROM admin_signup_approvals) THEN
    RAISE EXCEPTION
      'admin_signup_approvals still holds rows; remove or migrate them before rolling back';
  END IF;
END
$admin_signup_approval_rollback_guard$;

REVOKE USAGE ON SEQUENCE teacher_profiles_id_seq FROM classhub_app;
REVOKE INSERT (
  user_id, status, temporary_password_must_change, temporary_password_expires_at,
  created_by_operator_id, created_by_admin_account_id
) ON teacher_profiles FROM classhub_app;
REVOKE SELECT, INSERT ON admin_signup_approval_events FROM classhub_app;
REVOKE UPDATE (failed_attempts, consumed_at, consumed_by_user_id, revoked_at)
  ON admin_signup_approvals FROM classhub_app;
REVOKE INSERT (
  email_key_digest, role, code_digest, expires_at, issued_by_admin_account_id
) ON admin_signup_approvals FROM classhub_app;
REVOKE SELECT ON admin_signup_approvals FROM classhub_app;

DROP TABLE admin_signup_approval_events;
DROP TABLE admin_signup_approvals;

ALTER TABLE users
  DROP COLUMN signup_approved_at;

ALTER TABLE teacher_profiles
  DROP CONSTRAINT teacher_profiles_creator_check,
  DROP COLUMN created_by_admin_account_id,
  ALTER COLUMN created_by_operator_id SET NOT NULL;
