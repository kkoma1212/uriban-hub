-- T-HUB-62 MariaDB baseline phase 0001 (development only).
-- Provisional target: MariaDB 11.4 LTS. Apply only to the isolated synthetic dev database.
-- This is not a translation of PostgreSQL history and is not a complete product schema.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE users (
  id BIGINT NOT NULL AUTO_INCREMENT,
  email_normalized VARCHAR(320) NOT NULL,
  display_name VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email_verified_at DATETIME(6),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME(6),
  password_last_changed_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  deleted_at DATETIME(6),
  anonymized_at DATETIME(6),
  active_email_key VARCHAR(320)
    GENERATED ALWAYS AS (
      CASE WHEN deleted_at IS NULL THEN email_normalized ELSE NULL END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT users_active_email_unique UNIQUE (active_email_key),
  CONSTRAINT users_email_normalized_check CHECK (
    OCTET_LENGTH(email_normalized) = OCTET_LENGTH(TRIM(email_normalized))
    AND BINARY email_normalized = BINARY LOWER(email_normalized)
    AND email_normalized <> ''
  ),
  CONSTRAINT users_display_name_check CHECK (
    OCTET_LENGTH(display_name) = OCTET_LENGTH(TRIM(display_name))
    AND CHAR_LENGTH(display_name) BETWEEN 2 AND 20
  ),
  CONSTRAINT users_password_hash_check CHECK (password_hash <> ''),
  CONSTRAINT users_is_active_check CHECK (is_active IN (FALSE, TRUE)),
  CONSTRAINT users_failed_login_attempts_check CHECK (failed_login_attempts >= 0),
  CONSTRAINT users_anonymized_after_delete_check CHECK (
    anonymized_at IS NULL OR deleted_at IS NOT NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE user_consents (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  consent_type VARCHAR(32) NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  accepted_at DATETIME(6) NOT NULL,
  withdrawn_at DATETIME(6),
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin,
  retention_expires_at DATETIME(6),
  PRIMARY KEY (id),
  CONSTRAINT user_consents_identity_unique UNIQUE (user_id, consent_type, policy_version),
  CONSTRAINT user_consents_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_consents_type_check CHECK (
    consent_type IN ('terms', 'privacy', 'age_over_14')
  ),
  CONSTRAINT user_consents_policy_version_check CHECK (TRIM(policy_version) <> ''),
  CONSTRAINT user_consents_ip_address_check CHECK (
    ip_address IS NULL
    OR (
      INET6_ATON(ip_address) IS NOT NULL
      AND BINARY ip_address = BINARY INET6_NTOA(INET6_ATON(ip_address))
    )
  ),
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE email_verification_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  token_hash VARBINARY(32) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  used_at DATETIME(6),
  invalidated_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  open_user_id BIGINT
    GENERATED ALWAYS AS (
      CASE
        WHEN used_at IS NULL AND invalidated_at IS NULL THEN user_id
        ELSE NULL
      END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT email_verification_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT email_verification_tokens_one_open_per_user UNIQUE (open_user_id),
  CONSTRAINT email_verification_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT email_verification_tokens_hash_check CHECK (OCTET_LENGTH(token_hash) = 32),
  CONSTRAINT email_verification_tokens_terminal_state_check CHECK (
    (used_at IS NOT NULL) + (invalidated_at IS NOT NULL) <= 1
  ),
  CONSTRAINT email_verification_tokens_expiry_check CHECK (expires_at > created_at),
  INDEX email_verification_tokens_retention_index (
    user_id, used_at, invalidated_at, expires_at
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE password_reset_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  token_hash VARBINARY(32) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  used_at DATETIME(6),
  invalidated_at DATETIME(6),
  requested_ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  open_user_id BIGINT
    GENERATED ALWAYS AS (
      CASE
        WHEN used_at IS NULL AND invalidated_at IS NULL THEN user_id
        ELSE NULL
      END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT password_reset_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_one_open_per_user UNIQUE (open_user_id),
  CONSTRAINT password_reset_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT password_reset_tokens_hash_check CHECK (OCTET_LENGTH(token_hash) = 32),
  CONSTRAINT password_reset_tokens_terminal_state_check CHECK (
    (used_at IS NOT NULL) + (invalidated_at IS NOT NULL) <= 1
  ),
  CONSTRAINT password_reset_tokens_requested_ip_check CHECK (
    INET6_ATON(requested_ip) IS NOT NULL
    AND BINARY requested_ip = BINARY INET6_NTOA(INET6_ATON(requested_ip))
  ),
  CONSTRAINT password_reset_tokens_expiry_check CHECK (expires_at > created_at),
  INDEX password_reset_tokens_retention_index (
    user_id, used_at, invalidated_at, expires_at
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  session_hash VARBINARY(32) NOT NULL,
  csrf_token_hash VARBINARY(32) NOT NULL,
  issued_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6),
  created_ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_agent TEXT,
  PRIMARY KEY (id),
  CONSTRAINT sessions_session_hash_unique UNIQUE (session_hash),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT sessions_session_hash_check CHECK (OCTET_LENGTH(session_hash) = 32),
  CONSTRAINT sessions_csrf_token_hash_check CHECK (OCTET_LENGTH(csrf_token_hash) = 32),
  CONSTRAINT sessions_created_ip_check CHECK (
    INET6_ATON(created_ip) IS NOT NULL
    AND BINARY created_ip = BINARY INET6_NTOA(INET6_ATON(created_ip))
  ),
  CONSTRAINT sessions_expiry_check CHECK (expires_at > issued_at),
  INDEX sessions_user_active_index (user_id, revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE api_idempotency_keys (
  id BIGINT NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT NOT NULL,
  route_key VARCHAR(255) NOT NULL,
  idempotency_key UUID NOT NULL,
  request_hash VARBINARY(32) NOT NULL,
  response_status INT NOT NULL,
  response_body_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT api_idempotency_keys_identity_unique UNIQUE (
    actor_user_id, route_key, idempotency_key
  ),
  CONSTRAINT api_idempotency_keys_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT api_idempotency_keys_route_check CHECK (TRIM(route_key) <> ''),
  CONSTRAINT api_idempotency_keys_request_hash_check CHECK (OCTET_LENGTH(request_hash) = 32),
  CONSTRAINT api_idempotency_keys_response_body_check CHECK (
    JSON_VALID(response_body_json)
  ),
  CONSTRAINT api_idempotency_keys_success_status_check CHECK (
    response_status BETWEEN 200 AND 299
  ),
  CONSTRAINT api_idempotency_keys_expiry_check CHECK (expires_at > created_at),
  INDEX api_idempotency_keys_expiry_index (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
