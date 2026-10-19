-- Additive authentication extension. Isolated validation only until operating approval.
CREATE TABLE social_identities (
  identity_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id BIGINT NOT NULL,
  CONSTRAINT social_identities_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (provider IN ('google','naver','kakao')),
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(255) COLLATE utf8mb4_nopad_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  used_at DATETIME(6),
  UNIQUE (provider, issuer, subject),
  UNIQUE (user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE social_oauth_flows (
  flow_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (provider IN ('google','naver','kakao')),
  stage VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (stage IN ('oauth','signup')),
  state_hash VARBINARY(32) NOT NULL UNIQUE CHECK (OCTET_LENGTH(state_hash) = 32),
  browser_hash VARBINARY(32) NOT NULL CHECK (OCTET_LENGTH(browser_hash) = 32),
  encrypted_payload TEXT,
  created_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6),
  CONSTRAINT social_oauth_flows_expiry_check CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX social_oauth_flows_expiry_idx ON social_oauth_flows (expires_at);
