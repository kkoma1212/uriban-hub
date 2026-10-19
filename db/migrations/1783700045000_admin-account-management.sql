-- Up Migration
-- Administrator-managed accounts, roles, and operation audit trail.

ALTER TABLE admin_accounts
  ALTER COLUMN created_by_operator_id DROP NOT NULL,
  ADD COLUMN created_by_admin_account_id BIGINT
    REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  ADD CONSTRAINT admin_accounts_creator_check CHECK (
    num_nonnulls(created_by_operator_id, created_by_admin_account_id) = 1
  );

ALTER TABLE admin_account_roles
  ALTER COLUMN granted_by_operator_id DROP NOT NULL,
  ADD COLUMN granted_by_admin_account_id BIGINT
    REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  ADD CONSTRAINT admin_account_roles_grantor_check CHECK (
    num_nonnulls(granted_by_operator_id, granted_by_admin_account_id) = 1
  );

ALTER TABLE class_member_status_history
  DROP CONSTRAINT class_member_history_actor_check,
  ADD COLUMN actor_admin_account_id BIGINT
    REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  ADD CONSTRAINT class_member_history_actor_check CHECK (
    (
      actor_operator_id IS NOT NULL
      AND actor_admin_account_id IS NULL
      AND actor_user_id IS NULL
      AND actor_member_id IS NULL
    )
    OR
    (
      actor_operator_id IS NULL
      AND actor_admin_account_id IS NULL
      AND actor_user_id IS NOT NULL
    )
    OR
    (
      actor_operator_id IS NULL
      AND actor_admin_account_id IS NOT NULL
      AND actor_user_id IS NULL
      AND actor_member_id IS NULL
    )
  );

ALTER TABLE password_reset_tokens
  ADD COLUMN issued_by_admin_account_id BIGINT
    REFERENCES admin_accounts (id) ON DELETE RESTRICT;

CREATE TABLE admin_operation_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  actor_admin_account_id BIGINT NOT NULL
    REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'admin.account.created',
    'admin.account.status_changed',
    'admin.account.roles_changed',
    'admin.account.credentials_reset',
    'admin.account.password_changed',
    'admin.account.mfa_reset',
    'admin.signup_approval.issued',
    'admin.signup_approval.reissued',
    'admin.signup_approval.revoked',
    'admin.user.status_changed',
    'admin.user.password_reset_issued',
    'admin.member.status_changed',
    'admin.inquiry.updated',
    'admin.terms.created',
    'admin.terms.published',
    'admin.terms.retired',
    'admin.system_state.updated'
  )),
  target_type TEXT NOT NULL CHECK (
    target_type IN (
      'admin_account', 'signup_approval', 'user', 'member', 'inquiry',
      'terms_version', 'system_state'
    )
  ),
  target_id TEXT NOT NULL CHECK (btrim(target_id) <> ''),
  before_json JSONB,
  after_json JSONB,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 300),
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX admin_operation_audit_logs_created_index
  ON admin_operation_audit_logs (created_at DESC, id DESC);
CREATE INDEX admin_operation_audit_logs_actor_index
  ON admin_operation_audit_logs (actor_admin_account_id, created_at DESC);

REVOKE ALL PRIVILEGES ON admin_operation_audit_logs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON admin_operation_audit_logs_id_seq FROM PUBLIC;

GRANT SELECT (
  id, event_id, admin_account_id, action, deny_reason, request_id, created_at
) ON admin_auth_audit_logs TO classhub_app;
GRANT INSERT (
  email_normalized, display_name, password_hash, password_input_version,
  created_by_admin_account_id
) ON admin_accounts TO classhub_app;
GRANT UPDATE (
  password_hash, password_input_version, password_last_changed_at
) ON admin_accounts TO classhub_app;
GRANT INSERT (
  admin_account_id, role, granted_by_admin_account_id
) ON admin_account_roles TO classhub_app;
GRANT DELETE ON admin_account_roles TO classhub_app;
GRANT SELECT, INSERT ON admin_operation_audit_logs TO classhub_app;
GRANT USAGE ON SEQUENCE admin_accounts_id_seq,
  admin_operation_audit_logs_id_seq TO classhub_app;

-- Down Migration

DO $admin_account_management_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_operation_audit_logs)
    OR EXISTS (
      SELECT 1 FROM admin_accounts WHERE created_by_admin_account_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM admin_account_roles WHERE granted_by_admin_account_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM class_member_status_history WHERE actor_admin_account_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM password_reset_tokens WHERE issued_by_admin_account_id IS NOT NULL
    ) THEN
    RAISE EXCEPTION
      'administrator-managed account data exists; export and remove it before rolling back';
  END IF;
END
$admin_account_management_rollback_guard$;

REVOKE USAGE ON SEQUENCE admin_accounts_id_seq,
  admin_operation_audit_logs_id_seq FROM classhub_app;
REVOKE SELECT, INSERT ON admin_operation_audit_logs FROM classhub_app;
REVOKE DELETE ON admin_account_roles FROM classhub_app;
REVOKE INSERT (
  admin_account_id, role, granted_by_admin_account_id
) ON admin_account_roles FROM classhub_app;
REVOKE UPDATE (
  password_hash, password_input_version, password_last_changed_at
) ON admin_accounts FROM classhub_app;
REVOKE INSERT (
  email_normalized, display_name, password_hash, password_input_version,
  created_by_admin_account_id
) ON admin_accounts FROM classhub_app;
REVOKE SELECT (
  id, event_id, admin_account_id, action, deny_reason, request_id, created_at
) ON admin_auth_audit_logs FROM classhub_app;

DROP TABLE admin_operation_audit_logs;

ALTER TABLE password_reset_tokens
  DROP COLUMN issued_by_admin_account_id;

ALTER TABLE class_member_status_history
  DROP CONSTRAINT class_member_history_actor_check,
  DROP COLUMN actor_admin_account_id,
  ADD CONSTRAINT class_member_history_actor_check CHECK (
    (
      actor_operator_id IS NOT NULL
      AND actor_user_id IS NULL
      AND actor_member_id IS NULL
    )
    OR
    (
      actor_operator_id IS NULL
      AND actor_user_id IS NOT NULL
    )
  );

ALTER TABLE admin_account_roles
  DROP CONSTRAINT admin_account_roles_grantor_check,
  DROP COLUMN granted_by_admin_account_id,
  ALTER COLUMN granted_by_operator_id SET NOT NULL;

ALTER TABLE admin_accounts
  DROP CONSTRAINT admin_accounts_creator_check,
  DROP COLUMN created_by_admin_account_id,
  ALTER COLUMN created_by_operator_id SET NOT NULL;
