-- Up Migration
CREATE TABLE admin_terms_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL CHECK (
    document_type IN ('terms','privacy_consent','privacy_policy','guardian_consent')
  ),
  policy_version TEXT NOT NULL CHECK (
    policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 80
  ),
  title TEXT NOT NULL CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 200
  ),
  content TEXT NOT NULL CHECK (
    content = btrim(content) AND char_length(content) BETWEEN 1 AND 100000
  ),
  content_sha256 BYTEA NOT NULL CHECK (octet_length(content_sha256) = 32),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  published_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ,
  created_by_admin_account_id BIGINT NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_terms_versions_document_version_unique UNIQUE (document_type, policy_version),
  CONSTRAINT admin_terms_versions_lifecycle_check CHECK (
    (status = 'draft' AND published_at IS NULL AND effective_at IS NULL)
    OR
    (status IN ('published','retired') AND published_at IS NOT NULL AND effective_at IS NOT NULL)
  )
);
CREATE INDEX admin_terms_versions_status_index
  ON admin_terms_versions (document_type, status, created_at DESC);
CREATE UNIQUE INDEX admin_terms_versions_one_published_per_type
  ON admin_terms_versions (document_type)
  WHERE status = 'published';

-- The application may read versions and create drafts; publication changes are
-- deliberately limited to the small mutable surface used by the admin API.
REVOKE ALL PRIVILEGES ON admin_terms_versions FROM PUBLIC;
GRANT SELECT ON admin_terms_versions TO classhub_app;
GRANT INSERT (
  document_type, policy_version, title, content, content_sha256,
  created_by_admin_account_id
) ON admin_terms_versions TO classhub_app;
GRANT UPDATE (status, published_at, effective_at) ON admin_terms_versions TO classhub_app;

-- Down Migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_terms_versions) THEN
    RAISE EXCEPTION 'cannot roll back admin_terms_versions while data exists';
  END IF;
END $$;
REVOKE UPDATE (status, published_at, effective_at) ON admin_terms_versions FROM classhub_app;
REVOKE INSERT (
  document_type, policy_version, title, content, content_sha256,
  created_by_admin_account_id
) ON admin_terms_versions FROM classhub_app;
REVOKE SELECT ON admin_terms_versions FROM classhub_app;
DROP TABLE admin_terms_versions;
