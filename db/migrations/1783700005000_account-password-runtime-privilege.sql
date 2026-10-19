-- Up Migration

-- Password changes clear the teacher's one-time temporary-password gate in
-- the same transaction as the password hash update and session revocation.
-- Keep the runtime grant limited to those two state columns.
GRANT UPDATE (
  temporary_password_must_change,
  temporary_password_expires_at
) ON teacher_profiles TO classhub_app;

-- Down Migration

REVOKE UPDATE (
  temporary_password_must_change,
  temporary_password_expires_at
) ON teacher_profiles FROM classhub_app;
