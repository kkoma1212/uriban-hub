-- Prepared only. No operating schema/ACL activation is authorized.
-- Install-catalog conventions: supported column types only (public key as VARBINARY, COSE keys are
-- well under 2048 bytes), every table CHECK and FOREIGN KEY is a named constraint.

CREATE TABLE admin_passkeys (
  credential_id VARCHAR(1400) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_passkeys_account_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE CASCADE,
  public_key VARBINARY(2048) NOT NULL,
  user_handle VARCHAR(64) NOT NULL,
  signature_counter BIGINT NOT NULL DEFAULT 0 CHECK (signature_counter BETWEEN 0 AND 4294967295),
  transports_json VARCHAR(255) NOT NULL,
  device_type VARCHAR(16) NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up BOOLEAN NOT NULL,
  label VARCHAR(60) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  used_at DATETIME(6),
  revoked_at DATETIME(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX admin_passkeys_account_idx ON admin_passkeys (admin_account_id);

CREATE TABLE admin_recovery_codes (
  id VARCHAR(36) PRIMARY KEY,
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_recovery_codes_account_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE CASCADE,
  code_hash VARBINARY(32) NOT NULL UNIQUE CHECK (OCTET_LENGTH(code_hash) = 32),
  created_at DATETIME(6) NOT NULL,
  used_at DATETIME(6),
  revoked_at DATETIME(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX admin_recovery_codes_account_idx ON admin_recovery_codes (admin_account_id);

CREATE TABLE admin_webauthn_challenges (
  id VARCHAR(36) PRIMARY KEY,
  admin_account_id BIGINT NOT NULL,
  CONSTRAINT admin_webauthn_challenges_account_fk FOREIGN KEY (admin_account_id) REFERENCES admin_accounts (id) ON DELETE CASCADE,
  binding_hash VARBINARY(32) NOT NULL CHECK (OCTET_LENGTH(binding_hash) = 32),
  purpose VARCHAR(16) NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  challenge VARCHAR(128) NOT NULL,
  user_handle VARCHAR(64),
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6),
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT admin_webauthn_challenges_expiry_check CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX admin_webauthn_challenges_account_idx ON admin_webauthn_challenges (admin_account_id);

CREATE TABLE admin_mfa_stepups (
  session_id BIGINT PRIMARY KEY,
  CONSTRAINT admin_mfa_stepups_session_fk FOREIGN KEY (session_id) REFERENCES admin_sessions (id) ON DELETE CASCADE,
  method VARCHAR(16) NOT NULL CHECK (method IN ('totp', 'passkey', 'recovery')),
  verified_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE admin_auth_audit_logs DROP CONSTRAINT admin_auth_audit_logs_action_check,
  ADD CONSTRAINT admin_auth_audit_logs_action_check CHECK (action IN (
    'admin.auth.login_failed',
    'admin.auth.password_verified',
    'admin.auth.mfa_enrolled',
    'admin.auth.login_succeeded',
    'admin.auth.logout',
    'admin.auth.session_expired',
    'admin.auth.step_up_failed',
    'admin.auth.step_up_succeeded',
    'admin.auth.passkey_registered',
    'admin.auth.passkey_deleted',
    'admin.auth.totp_revoked',
    'admin.auth.recovery_codes_issued',
    'admin.auth.recovery_code_used',
    'admin.auth.factor_change_failed'
  ));
