-- Up Migration

CREATE TABLE guardian_consent_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_email_normalized TEXT NOT NULL,
  approval_token_hash BYTEA UNIQUE,
  completion_token_hash BYTEA UNIQUE,
  terms_policy_version TEXT NOT NULL,
  privacy_policy_version TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  user_id BIGINT UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT guardian_consent_requests_email_normalized_check CHECK (
    guardian_email_normalized = lower(btrim(guardian_email_normalized))
    AND guardian_email_normalized <> ''
  ),
  CONSTRAINT guardian_consent_requests_approval_hash_check CHECK (
    approval_token_hash IS NULL OR octet_length(approval_token_hash) = 32
  ),
  CONSTRAINT guardian_consent_requests_completion_hash_check CHECK (
    completion_token_hash IS NULL OR octet_length(completion_token_hash) = 32
  ),
  CONSTRAINT guardian_consent_requests_terms_version_check CHECK (
    terms_policy_version = btrim(terms_policy_version)
    AND terms_policy_version <> ''
  ),
  CONSTRAINT guardian_consent_requests_privacy_version_check CHECK (
    privacy_policy_version = btrim(privacy_policy_version)
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
);

CREATE INDEX guardian_consent_requests_open_approval_token_index
  ON guardian_consent_requests (approval_token_hash)
  WHERE approval_token_hash IS NOT NULL
    AND approved_at IS NULL
    AND consumed_at IS NULL
    AND invalidated_at IS NULL;

CREATE INDEX guardian_consent_requests_open_completion_token_index
  ON guardian_consent_requests (completion_token_hash)
  WHERE completion_token_hash IS NOT NULL
    AND consumed_at IS NULL
    AND invalidated_at IS NULL;

CREATE INDEX guardian_consent_requests_expiry_index
  ON guardian_consent_requests (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX guardian_consent_requests_retention_index
  ON guardian_consent_requests (requested_at)
  WHERE user_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON guardian_consent_requests
  TO classhub_app;

GRANT SELECT, DELETE
  ON guardian_consent_requests
  TO classhub_retention;

-- Down Migration

DROP TABLE guardian_consent_requests;
