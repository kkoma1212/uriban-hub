-- Up Migration

-- NULL preserves legacy accounts whose original signup choice was not recorded.
-- Never infer that choice from a subsequently issued approval code.
ALTER TABLE users
  ADD COLUMN signup_role TEXT,
  ADD CONSTRAINT users_signup_role_check CHECK (signup_role IN ('student', 'teacher'));

COMMENT ON COLUMN users.signup_role IS
  'Account type selected at signup; not a grant of teacher or class privileges.';

-- Down Migration

DO $signup_role_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE signup_role IS NOT NULL) THEN
    RAISE EXCEPTION 'Recorded signup roles must be preserved; roll back the application only';
  END IF;
END;
$signup_role_rollback_guard$;
ALTER TABLE users DROP CONSTRAINT users_signup_role_check;
ALTER TABLE users DROP COLUMN signup_role;
