-- T-HUB-64 phase 0021; isolated synthetic development only, runtime ACLs separate.
-- PostgreSQL source: 1783700042000_admin-signup-approval.sql (Up only).
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE users ADD COLUMN signup_approved_at DATETIME(6);
ALTER TABLE teacher_profiles
  MODIFY COLUMN created_by_operator_id BIGINT NULL,
  ADD COLUMN created_by_admin_account_id BIGINT,
  ADD CONSTRAINT teacher_profiles_admin_creator_fk FOREIGN KEY (created_by_admin_account_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT teacher_profiles_creator_check CHECK (
    (created_by_operator_id IS NOT NULL) + (created_by_admin_account_id IS NOT NULL) = 1
  );

CREATE TABLE admin_signup_approvals (
  id UUID NOT NULL PRIMARY KEY DEFAULT (CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4',
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(8 | (ORD(RANDOM_BYTES(1)) & 3)),
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(RANDOM_BYTES(6)))),
  email_key_digest VARBINARY(32) NOT NULL,
  role VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL,
  code_digest VARBINARY(32) NOT NULL UNIQUE,
  failed_attempts INT NOT NULL DEFAULT 0,
  issued_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6),
  consumed_by_user_id BIGINT,
  CONSTRAINT admin_signup_approvals_consumed_by_user_id_fk FOREIGN KEY (consumed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at DATETIME(6),
  issued_by_admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_signup_approvals_issued_by_admin_account_id_fk FOREIGN KEY (issued_by_admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  open_email_key_digest VARBINARY(32) GENERATED ALWAYS AS (
    CASE WHEN consumed_at IS NULL AND revoked_at IS NULL THEN email_key_digest ELSE NULL END
  ) STORED,
  CONSTRAINT admin_signup_approvals_email_digest_check CHECK (OCTET_LENGTH(email_key_digest) = 32),
  CONSTRAINT admin_signup_approvals_code_digest_check CHECK (OCTET_LENGTH(code_digest) = 32),
  CONSTRAINT admin_signup_approvals_role_check CHECK (role IN ('teacher', 'student')),
  CONSTRAINT admin_signup_approvals_attempts_check CHECK (failed_attempts BETWEEN 0 AND 5),
  CONSTRAINT admin_signup_approvals_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT admin_signup_approvals_terminal_check CHECK (((consumed_at IS NOT NULL) + (revoked_at IS NOT NULL)) <= 1),
  CONSTRAINT admin_signup_approvals_consumer_check CHECK (
    (consumed_at IS NULL AND consumed_by_user_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL AND revoked_at IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE UNIQUE INDEX admin_signup_approvals_open_email_role_index
  ON admin_signup_approvals (open_email_key_digest, role);

CREATE TABLE admin_signup_approval_events (
  id UUID NOT NULL PRIMARY KEY DEFAULT (CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4',
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(8 | (ORD(RANDOM_BYTES(1)) & 3)),
    RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(RANDOM_BYTES(6)))),
  approval_id UUID,
  CONSTRAINT admin_signup_approval_events_approval_id_fk FOREIGN KEY (approval_id) REFERENCES admin_signup_approvals (id) ON DELETE RESTRICT,
  admin_actor_account_id BIGINT,
  CONSTRAINT admin_signup_approval_events_admin_actor_account_id_fk FOREIGN KEY (admin_actor_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  user_actor_id BIGINT,
  CONSTRAINT admin_signup_approval_events_user_actor_id_fk FOREIGN KEY (user_actor_id) REFERENCES users (id) ON DELETE RESTRICT,
  role LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  action LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  result_code LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  request_id UUID NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX admin_signup_approval_events_approval_index
  ON admin_signup_approval_events (approval_id, created_at DESC);
CREATE INDEX admin_signup_approval_events_created_index
  ON admin_signup_approval_events (created_at DESC, id DESC);
