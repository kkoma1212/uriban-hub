-- T-HUB-62 MariaDB migration ledger bootstrap (development design only).
-- Run once in the selected target database before any numbered product phase.

CREATE TABLE classhub_schema_migrations (
  version BIGINT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  source_sha256 VARBINARY(32) NOT NULL,
  applied_at_utc DATETIME(6) NOT NULL,
  server_version VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (version),
  CONSTRAINT classhub_schema_migrations_source_sha256_unique UNIQUE (source_sha256),
  CONSTRAINT classhub_schema_migrations_version_check CHECK (version > 0),
  CONSTRAINT classhub_schema_migrations_description_check CHECK (
    CHAR_LENGTH(description) BETWEEN 1 AND 255
    AND OCTET_LENGTH(description) = OCTET_LENGTH(TRIM(description))
  ),
  CONSTRAINT classhub_schema_migrations_source_sha256_check CHECK (
    OCTET_LENGTH(source_sha256) = 32
  ),
  CONSTRAINT classhub_schema_migrations_server_version_check CHECK (
    CHAR_LENGTH(server_version) BETWEEN 1 AND 128
    AND OCTET_LENGTH(server_version) = OCTET_LENGTH(TRIM(server_version))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  COMMENT='Operational migration ledger; excluded from product table inventory';
