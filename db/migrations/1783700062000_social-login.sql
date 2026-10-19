-- Up Migration
-- Additive authentication extension. Isolated validation only until operating approval.
CREATE TABLE social_identities (
  identity_id VARCHAR(36) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('google','naver','kakao')),
  issuer VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  UNIQUE (provider, issuer, subject),
  UNIQUE (user_id, provider)
);
CREATE TABLE social_oauth_flows (
  flow_id VARCHAR(36) PRIMARY KEY,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('google','naver','kakao')),
  stage VARCHAR(16) NOT NULL CHECK (stage IN ('oauth','signup')),
  state_hash BYTEA NOT NULL UNIQUE CHECK (OCTET_LENGTH(state_hash) = 32),
  browser_hash BYTEA NOT NULL CHECK (OCTET_LENGTH(browser_hash) = 32),
  encrypted_payload TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX social_oauth_flows_expiry_idx ON social_oauth_flows (expires_at);
GRANT SELECT, INSERT, DELETE ON social_identities TO classhub_app;
GRANT UPDATE (used_at) ON social_identities TO classhub_app;
GRANT SELECT, INSERT, DELETE ON social_oauth_flows TO classhub_app;
GRANT UPDATE (encrypted_payload, consumed_at) ON social_oauth_flows TO classhub_app;

-- Down Migration
DROP TABLE social_oauth_flows, social_identities;
