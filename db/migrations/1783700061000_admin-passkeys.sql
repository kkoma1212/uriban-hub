-- Up Migration

-- Prepared only. Apply to an isolated database until explicit operating approval.

CREATE TABLE admin_passkeys (
  credential_id VARCHAR(1400) PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  user_handle VARCHAR(64) NOT NULL,
  signature_counter BIGINT NOT NULL DEFAULT 0 CHECK (signature_counter BETWEEN 0 AND 4294967295),
  transports_json VARCHAR(255) NOT NULL,
  device_type VARCHAR(16) NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up BOOLEAN NOT NULL,
  label VARCHAR(60) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX admin_passkeys_account_idx ON admin_passkeys (admin_account_id);

CREATE TABLE admin_recovery_codes (
  id VARCHAR(36) PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE CASCADE,
  code_hash BYTEA NOT NULL UNIQUE CHECK (OCTET_LENGTH(code_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX admin_recovery_codes_account_idx ON admin_recovery_codes (admin_account_id);

CREATE TABLE admin_webauthn_challenges (
  id VARCHAR(36) PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts (id) ON DELETE CASCADE,
  binding_hash BYTEA NOT NULL CHECK (OCTET_LENGTH(binding_hash) = 32),
  purpose VARCHAR(16) NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  challenge VARCHAR(128) NOT NULL,
  user_handle VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX admin_webauthn_challenges_account_idx ON admin_webauthn_challenges (admin_account_id);

CREATE TABLE admin_mfa_stepups (
  session_id BIGINT PRIMARY KEY REFERENCES admin_sessions (id) ON DELETE CASCADE,
  method VARCHAR(16) NOT NULL CHECK (method IN ('totp', 'passkey', 'recovery')),
  verified_at TIMESTAMPTZ NOT NULL
);

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
GRANT SELECT, INSERT ON admin_passkeys TO classhub_app;
GRANT UPDATE (signature_counter, backed_up, used_at, revoked_at) ON admin_passkeys TO classhub_app;
GRANT SELECT, INSERT ON admin_recovery_codes TO classhub_app;
GRANT UPDATE (used_at, revoked_at) ON admin_recovery_codes TO classhub_app;
GRANT SELECT, INSERT ON admin_webauthn_challenges TO classhub_app;
GRANT UPDATE (consumed_at) ON admin_webauthn_challenges TO classhub_app;
GRANT SELECT, INSERT ON admin_mfa_stepups TO classhub_app;
GRANT UPDATE (method, verified_at) ON admin_mfa_stepups TO classhub_app;
GRANT DELETE ON admin_mfa_stepups TO classhub_app;

-- Down Migration
-- Feature flags must be disabled; preserve a backup of factors and audit events first.
DROP TABLE admin_mfa_stepups, admin_webauthn_challenges, admin_recovery_codes, admin_passkeys;
-- Keep the expanded audit action allowlist: history is append-only.
