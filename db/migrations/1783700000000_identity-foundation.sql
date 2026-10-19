-- Up Migration

CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_last_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  anonymized_at TIMESTAMPTZ,
  CONSTRAINT users_email_normalized_check CHECK (
    email_normalized = lower(btrim(email_normalized))
    AND email_normalized <> ''
  ),
  CONSTRAINT users_display_name_check CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 2 AND 20
  ),
  CONSTRAINT users_password_hash_check CHECK (password_hash <> ''),
  CONSTRAINT users_failed_login_attempts_check CHECK (failed_login_attempts >= 0),
  CONSTRAINT users_anonymized_after_delete_check CHECK (
    anonymized_at IS NULL OR deleted_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX users_active_email_unique
  ON users (email_normalized)
  WHERE deleted_at IS NULL;

CREATE TABLE user_consents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  withdrawn_at TIMESTAMPTZ,
  ip_address INET,
  retention_expires_at TIMESTAMPTZ,
  CONSTRAINT user_consents_identity_unique UNIQUE (user_id, consent_type, policy_version),
  CONSTRAINT user_consents_type_check CHECK (
    consent_type IN ('terms', 'privacy', 'age_over_14')
  ),
  CONSTRAINT user_consents_policy_version_check CHECK (btrim(policy_version) <> ''),
  CONSTRAINT user_consents_state_check CHECK (
    (
      withdrawn_at IS NULL
      AND retention_expires_at IS NULL
      AND ip_address IS NOT NULL
    )
    OR
    (
      withdrawn_at IS NOT NULL
      AND retention_expires_at IS NOT NULL
      AND ip_address IS NULL
      AND retention_expires_at > withdrawn_at
    )
  )
);

CREATE TABLE email_verification_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_tokens_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT email_verification_tokens_terminal_state_check CHECK (
    num_nonnulls(used_at, invalidated_at) <= 1
  ),
  CONSTRAINT email_verification_tokens_expiry_check CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX email_verification_tokens_one_open_per_user
  ON email_verification_tokens (user_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX email_verification_tokens_retention_index
  ON email_verification_tokens (user_id, used_at, invalidated_at, expires_at);

CREATE TABLE password_reset_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  requested_ip INET NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT password_reset_tokens_terminal_state_check CHECK (
    num_nonnulls(used_at, invalidated_at) <= 1
  ),
  CONSTRAINT password_reset_tokens_expiry_check CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX password_reset_tokens_one_open_per_user
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX password_reset_tokens_retention_index
  ON password_reset_tokens (user_id, used_at, invalidated_at, expires_at);

CREATE TABLE sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_hash BYTEA NOT NULL UNIQUE,
  csrf_token_hash BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_ip INET NOT NULL,
  user_agent TEXT,
  CONSTRAINT sessions_session_hash_check CHECK (octet_length(session_hash) = 32),
  CONSTRAINT sessions_csrf_token_hash_check CHECK (octet_length(csrf_token_hash) = 32),
  CONSTRAINT sessions_expiry_check CHECK (expires_at > issued_at)
);

CREATE INDEX sessions_user_active_index
  ON sessions (user_id, revoked_at, expires_at);

CREATE TABLE api_idempotency_keys (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  route_key TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  request_hash BYTEA NOT NULL,
  response_status INTEGER NOT NULL,
  response_body_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT api_idempotency_keys_identity_unique UNIQUE (
    actor_user_id,
    route_key,
    idempotency_key
  ),
  CONSTRAINT api_idempotency_keys_route_check CHECK (btrim(route_key) <> ''),
  CONSTRAINT api_idempotency_keys_request_hash_check CHECK (octet_length(request_hash) = 32),
  CONSTRAINT api_idempotency_keys_success_status_check CHECK (
    response_status BETWEEN 200 AND 299
  ),
  CONSTRAINT api_idempotency_keys_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX api_idempotency_keys_expiry_index
  ON api_idempotency_keys (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON users,
     user_consents,
     email_verification_tokens,
     password_reset_tokens,
     sessions,
     api_idempotency_keys
  TO classhub_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO classhub_app;
REVOKE ALL ON TABLE pgmigrations FROM classhub_app;

-- Down Migration

DROP TABLE api_idempotency_keys;
DROP TABLE sessions;
DROP TABLE password_reset_tokens;
DROP TABLE email_verification_tokens;
DROP TABLE user_consents;
DROP TABLE users;
