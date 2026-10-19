-- Record phase 0001 only after its source SQL and verification both succeed.
-- A missing or non-InnoDB phase table deliberately turns version into zero,
-- which the ledger CHECK rejects without creating an applied row.

INSERT INTO classhub_schema_migrations (
  version,
  description,
  source_sha256,
  applied_at_utc,
  server_version
)
SELECT
  CASE WHEN phase_table_count = 6 THEN 1 ELSE 0 END,
  'identity_foundation',
  UNHEX('8dd18cce674a69209e2cd96df27796ddb22681dfb21a769669fc8f821611987a'),
  UTC_TIMESTAMP(6),
  VERSION()
FROM (
  SELECT COUNT(*) AS phase_table_count
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE = 'BASE TABLE'
    AND ENGINE = 'InnoDB'
    AND TABLE_NAME IN (
      'users',
      'user_consents',
      'email_verification_tokens',
      'password_reset_tokens',
      'sessions',
      'api_idempotency_keys'
    )
) AS phase_0001_guard;
