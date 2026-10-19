-- Up Migration

-- Existing hashes were created before Unicode normalization became part of the
-- password contract. The default therefore preserves the exact legacy input
-- semantics for every pre-existing row and for any older application binary
-- still completing an in-flight write during a rolling deployment.
ALTER TABLE users
  ADD COLUMN password_input_version TEXT NOT NULL DEFAULT 'legacy_exact_v0',
  ADD CONSTRAINT users_password_input_version_check
    CHECK (password_input_version IN ('legacy_exact_v0', 'nfc_v1'));

COMMENT ON COLUMN users.password_input_version IS
  'Selects password preprocessing before the single Argon2id verification.';

-- The HTTP application already has table-level users privileges. The operator
-- role is deliberately column-scoped and needs this column only when issuing a
-- new teacher temporary password or replacing one.
GRANT INSERT (password_input_version), UPDATE (password_input_version)
  ON users TO classhub_operator;

-- Down Migration

REVOKE INSERT (password_input_version), UPDATE (password_input_version)
  ON users FROM classhub_operator;
ALTER TABLE users DROP CONSTRAINT users_password_input_version_check;
ALTER TABLE users DROP COLUMN password_input_version;
