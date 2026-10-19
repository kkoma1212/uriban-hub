-- T-HUB-64 phase 0024; isolated synthetic development only, runtime ACLs separate.
-- PostgreSQL source: 1783700045000_admin-account-management.sql (Up only).
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE admin_accounts
  MODIFY COLUMN created_by_operator_id BIGINT NULL,
  ADD COLUMN created_by_admin_account_id BIGINT,
  ADD CONSTRAINT admin_accounts_admin_creator_fk FOREIGN KEY (created_by_admin_account_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT admin_accounts_creator_check CHECK (
    (created_by_operator_id IS NOT NULL) + (created_by_admin_account_id IS NOT NULL) = 1
  );
ALTER TABLE admin_account_roles
  MODIFY COLUMN granted_by_operator_id BIGINT NULL,
  ADD COLUMN granted_by_admin_account_id BIGINT,
  ADD CONSTRAINT admin_account_roles_admin_grantor_fk FOREIGN KEY (granted_by_admin_account_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT admin_account_roles_grantor_check CHECK (
    (granted_by_operator_id IS NOT NULL) + (granted_by_admin_account_id IS NOT NULL) = 1
  );
ALTER TABLE class_member_status_history
  ADD COLUMN actor_admin_account_id BIGINT,
  ADD CONSTRAINT class_member_history_actor_admin_fk FOREIGN KEY (actor_admin_account_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT;
-- The source actor CHECK is already represented by the append-only INSERT trigger.
-- Its replacement in 0024_admin_history_trigger.sql preserves role/status validation.
ALTER TABLE password_reset_tokens
  ADD COLUMN issued_by_admin_account_id BIGINT,
  ADD CONSTRAINT password_reset_tokens_admin_issuer_fk FOREIGN KEY (issued_by_admin_account_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT;

CREATE TABLE admin_operation_audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE DEFAULT (CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4',
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(8 | (ORD(RANDOM_BYTES(1)) & 3)),
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(RANDOM_BYTES(6)))),
  actor_admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_operation_audit_logs_actor_admin_account_id_fk FOREIGN KEY (actor_admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  action LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (action IN (
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
  target_type LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (
    target_type IN (
      'admin_account', 'signup_approval', 'user', 'member', 'inquiry',
      'terms_version', 'system_state'
    )
  ),
  target_id LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (TRIM(target_id) <> ''),
  before_json JSON,
  after_json JSON,
  reason LONGTEXT COLLATE utf8mb4_nopad_bin CHECK (reason IS NULL OR CHAR_LENGTH(reason) <= 300),
  request_id UUID NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX admin_operation_audit_logs_created_index
  ON admin_operation_audit_logs (created_at DESC, id DESC);
CREATE INDEX admin_operation_audit_logs_actor_index
  ON admin_operation_audit_logs (actor_admin_account_id, created_at DESC);
