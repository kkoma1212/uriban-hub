-- Up Migration
-- T-HUB-65: one persisted pair is shared by all API instances.
ALTER TABLE admin_system_state DROP CONSTRAINT admin_system_state_key_check;
ALTER TABLE admin_system_state ADD CONSTRAINT admin_system_state_key_check
  CHECK (key IN ('maintenance_mode', 'announcement', 'request_limits'));
-- Attempt throttling now uses the shared Redis cooldown. Keep the historical count.
ALTER TABLE admin_signup_approvals DROP CONSTRAINT admin_signup_approvals_attempts_check;
ALTER TABLE admin_signup_approvals ADD CONSTRAINT admin_signup_approvals_attempts_check
  CHECK (failed_attempts >= 0);

-- Down Migration
DO $request_limit_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_signup_approvals WHERE failed_attempts > 5) THEN
    RAISE EXCEPTION 'preserve approval attempt history before restoring the old count constraint';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_system_state WHERE key = 'request_limits') THEN
    RAISE EXCEPTION 'export the saved request limit policy before removing it and rolling back';
  END IF;
END
$request_limit_rollback_guard$;
ALTER TABLE admin_signup_approvals DROP CONSTRAINT admin_signup_approvals_attempts_check;
ALTER TABLE admin_signup_approvals ADD CONSTRAINT admin_signup_approvals_attempts_check
  CHECK (failed_attempts BETWEEN 0 AND 5);
ALTER TABLE admin_system_state DROP CONSTRAINT admin_system_state_key_check;
ALTER TABLE admin_system_state ADD CONSTRAINT admin_system_state_key_check
  CHECK (key IN ('maintenance_mode', 'announcement'));
