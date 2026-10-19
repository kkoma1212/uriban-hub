-- T-HUB-64 phase 0023. Isolated synthetic development only; runtime ACLs remain separate.
-- PostgreSQL source: 1783700044000_admin-terms-management.sql (Up only).
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE admin_terms_versions (
  -- Same UUID v4 expression as phase 0019: 122 random bits with fixed version/variant.
  id UUID NOT NULL PRIMARY KEY DEFAULT (
    CONCAT(HEX(RANDOM_BYTES(4)), '-', HEX(RANDOM_BYTES(2)), '-4',
      RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(8 | (ORD(RANDOM_BYTES(1)) & 3)),
      RIGHT(HEX(RANDOM_BYTES(2)), 3), '-', HEX(RANDOM_BYTES(6)))
  ),
  document_type VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL,
  policy_version LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  title LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  content LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  content_sha256 VARBINARY(32) NOT NULL,
  status VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL DEFAULT 'draft',
  published_at DATETIME(6),
  effective_at DATETIME(6),
  created_by_admin_account_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  published_document_type VARCHAR(64) COLLATE utf8mb4_nopad_bin
    GENERATED ALWAYS AS (
      CASE WHEN status = 'published' THEN document_type ELSE NULL END
    ) STORED,
  CONSTRAINT admin_terms_versions_document_type_check CHECK (
    document_type IN ('terms', 'privacy_consent', 'privacy_policy', 'guardian_consent')
  ),
  CONSTRAINT admin_terms_versions_policy_version_check CHECK (
    BINARY policy_version = BINARY TRIM(policy_version)
    AND CHAR_LENGTH(policy_version) BETWEEN 1 AND 80
  ),
  CONSTRAINT admin_terms_versions_title_check CHECK (
    BINARY title = BINARY TRIM(title)
    AND CHAR_LENGTH(title) BETWEEN 1 AND 200
  ),
  CONSTRAINT admin_terms_versions_content_check CHECK (
    BINARY content = BINARY TRIM(content)
    AND CHAR_LENGTH(content) BETWEEN 1 AND 100000
  ),
  CONSTRAINT admin_terms_versions_content_sha256_check CHECK (
    OCTET_LENGTH(content_sha256) = 32
  ),
  CONSTRAINT admin_terms_versions_status_check CHECK (
    status IN ('draft', 'published', 'retired')
  ),
  CONSTRAINT admin_terms_versions_created_by_admin_account_id_fk
    FOREIGN KEY (created_by_admin_account_id) REFERENCES admin_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT admin_terms_versions_lifecycle_check CHECK (
    (status = 'draft' AND published_at IS NULL AND effective_at IS NULL)
    OR
    (status IN ('published', 'retired') AND published_at IS NOT NULL AND effective_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Every valid policy version is fully indexed; LONGTEXT avoids pre-CHECK space truncation.
CREATE UNIQUE INDEX admin_terms_versions_document_version_unique
  ON admin_terms_versions (document_type, policy_version(80));
CREATE INDEX admin_terms_versions_status_index
  ON admin_terms_versions (document_type, status, created_at DESC);
CREATE UNIQUE INDEX admin_terms_versions_one_published_per_type
  ON admin_terms_versions (published_document_type);

-- Source has no content/digest equality, control-character, or timestamp-order predicate.
-- UTC_TIMESTAMP is statement time; PostgreSQL clock_timestamp() is per-call wall time.
