-- T-HUB-64 phase 0019. Isolated synthetic development only; runtime ACLs remain separate.
-- PostgreSQL source: 1783700038000_guardian-consent-requests.sql (Up only).
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE guardian_consent_requests (
  -- UUID v4: 122 random bits; fixed version 4 and RFC 4122 variant bits.
  id UUID NOT NULL PRIMARY KEY DEFAULT (
    CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4',
      RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(8 | (ORD(RANDOM_BYTES(1)) & 3)),
      RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(RANDOM_BYTES(6)))
  ),
  guardian_email_normalized LONGTEXT NOT NULL,
  approval_token_hash VARBINARY(32),
  CONSTRAINT guardian_consent_requests_approval_hash_unique UNIQUE (approval_token_hash),
  completion_token_hash VARBINARY(32),
  CONSTRAINT guardian_consent_requests_completion_hash_unique UNIQUE (completion_token_hash),
  terms_policy_version LONGTEXT NOT NULL,
  privacy_policy_version LONGTEXT NOT NULL,
  requested_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  approved_at DATETIME(6),
  consumed_at DATETIME(6),
  invalidated_at DATETIME(6),
  user_id BIGINT,
  CONSTRAINT guardian_consent_requests_user_unique UNIQUE (user_id),
  CONSTRAINT guardian_consent_requests_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT guardian_consent_requests_email_normalized_check CHECK (
    BINARY guardian_email_normalized = BINARY LOWER(TRIM(guardian_email_normalized))
    AND guardian_email_normalized <> ''
  ),
  CONSTRAINT guardian_consent_requests_approval_hash_check CHECK (
    approval_token_hash IS NULL OR OCTET_LENGTH(approval_token_hash) = 32
  ),
  CONSTRAINT guardian_consent_requests_completion_hash_check CHECK (
    completion_token_hash IS NULL OR OCTET_LENGTH(completion_token_hash) = 32
  ),
  CONSTRAINT guardian_consent_requests_terms_version_check CHECK (
    BINARY terms_policy_version = BINARY TRIM(terms_policy_version)
    AND terms_policy_version <> ''
  ),
  CONSTRAINT guardian_consent_requests_privacy_version_check CHECK (
    BINARY privacy_policy_version = BINARY TRIM(privacy_policy_version)
    AND privacy_policy_version <> ''
  ),
  CONSTRAINT guardian_consent_requests_expiry_check CHECK (
    expires_at > requested_at
    AND (approved_at IS NULL OR approved_at <= expires_at)
    AND (consumed_at IS NULL OR consumed_at <= expires_at)
  ),
  CONSTRAINT guardian_consent_requests_timestamp_order_check CHECK (
    (approved_at IS NULL OR approved_at >= requested_at)
    AND (consumed_at IS NULL OR consumed_at >= approved_at)
    AND (invalidated_at IS NULL OR invalidated_at >= requested_at)
    AND (
      invalidated_at IS NULL
      OR approved_at IS NULL
      OR invalidated_at >= approved_at
    )
  ),
  CONSTRAINT guardian_consent_requests_state_check CHECK (
    (
      approved_at IS NULL
      AND consumed_at IS NULL
      AND invalidated_at IS NULL
      AND approval_token_hash IS NOT NULL
      AND completion_token_hash IS NOT NULL
      AND user_id IS NULL
    )
    OR
    (
      approved_at IS NOT NULL
      AND consumed_at IS NULL
      AND invalidated_at IS NULL
      AND approval_token_hash IS NULL
      AND completion_token_hash IS NOT NULL
      AND user_id IS NULL
    )
    OR
    (
      approved_at IS NOT NULL
      AND consumed_at IS NOT NULL
      AND invalidated_at IS NULL
      AND approval_token_hash IS NULL
      AND completion_token_hash IS NULL
      AND user_id IS NOT NULL
    )
    OR
    (
      consumed_at IS NULL
      AND invalidated_at IS NOT NULL
      AND user_id IS NULL
      AND approval_token_hash IS NULL
      AND completion_token_hash IS NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Global nullable UNIQUE hash indexes already support both open-token point lookups.
-- Composite indexes replace the two remaining non-unique partial indexes.
CREATE INDEX guardian_consent_requests_expiry_index
  ON guardian_consent_requests (consumed_at, invalidated_at, expires_at);
CREATE INDEX guardian_consent_requests_retention_index
  ON guardian_consent_requests (user_id, requested_at);
-- UTC_TIMESTAMP is statement time, not PostgreSQL now() transaction time.
-- Application transaction-time binding and Unicode lower() parity remain activation gates.
