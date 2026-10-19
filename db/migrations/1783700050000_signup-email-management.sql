-- Up Migration
ALTER TABLE admin_signup_approvals
  ALTER COLUMN issued_by_admin_account_id DROP NOT NULL,
  ADD COLUMN recipient_email VARCHAR(320),
  ADD COLUMN code_encrypted TEXT;

ALTER TABLE teacher_profiles
  ADD COLUMN created_by_signup_approval_id UUID REFERENCES admin_signup_approvals(id) ON DELETE RESTRICT,
  DROP CONSTRAINT teacher_profiles_creator_check,
  ADD CONSTRAINT teacher_profiles_creator_check CHECK (
    num_nonnulls(created_by_operator_id, created_by_admin_account_id, created_by_signup_approval_id) = 1
  );

ALTER TABLE admin_signup_approval_events
  DROP CONSTRAINT admin_signup_approval_events_actor_check,
  ADD CONSTRAINT admin_signup_approval_events_actor_check CHECK (
    (action IN ('issue', 'reissue', 'revoke') AND admin_actor_account_id IS NOT NULL AND user_actor_id IS NULL AND approval_id IS NOT NULL)
    OR (action IN ('issue', 'reissue') AND admin_actor_account_id IS NULL AND user_actor_id IS NOT NULL AND approval_id IS NOT NULL)
    OR (action = 'signup' AND result_code = 'approved' AND admin_actor_account_id IS NULL AND user_actor_id IS NOT NULL AND approval_id IS NOT NULL)
    OR (action = 'signup' AND result_code <> 'approved' AND admin_actor_account_id IS NULL AND user_actor_id IS NULL)
  );

CREATE TABLE mail_templates (
  key VARCHAR(64) PRIMARY KEY CHECK (key = 'signup_verification'),
  title VARCHAR(120) NOT NULL,
  introduction TEXT NOT NULL,
  footer TEXT NOT NULL,
  button_label VARCHAR(40) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_by_admin_account_id BIGINT NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT
);
CREATE TABLE mail_delivery_logs (
  id UUID PRIMARY KEY,
  recipient_email VARCHAR(320) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'accepted', 'failed')),
  failure_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX mail_delivery_logs_created_index ON mail_delivery_logs(created_at DESC, id DESC);
CREATE INDEX mail_delivery_logs_recipient_index ON mail_delivery_logs(recipient_email, created_at DESC);
REVOKE ALL ON mail_templates, mail_delivery_logs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mail_templates TO classhub_app;
GRANT SELECT, INSERT, UPDATE (status, failure_code, completed_at) ON mail_delivery_logs TO classhub_app;
GRANT INSERT (recipient_email, code_encrypted) ON admin_signup_approvals TO classhub_app;
GRANT INSERT (created_by_signup_approval_id) ON teacher_profiles TO classhub_app;

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM admin_signup_approvals WHERE issued_by_admin_account_id IS NULL OR code_encrypted IS NOT NULL)
    OR EXISTS (SELECT 1 FROM mail_delivery_logs) OR EXISTS (SELECT 1 FROM mail_templates) THEN
    RAISE EXCEPTION 'Preserve signup verification and mail history before rollback';
  END IF;
END $$;
REVOKE INSERT (created_by_signup_approval_id) ON teacher_profiles FROM classhub_app;
REVOKE INSERT (recipient_email, code_encrypted) ON admin_signup_approvals FROM classhub_app;
ALTER TABLE admin_signup_approval_events
  DROP CONSTRAINT admin_signup_approval_events_actor_check,
  ADD CONSTRAINT admin_signup_approval_events_actor_check CHECK (
    (action IN ('issue', 'reissue', 'revoke') AND admin_actor_account_id IS NOT NULL AND user_actor_id IS NULL AND approval_id IS NOT NULL)
    OR (action = 'signup' AND result_code = 'approved' AND admin_actor_account_id IS NULL AND user_actor_id IS NOT NULL AND approval_id IS NOT NULL)
    OR (action = 'signup' AND result_code <> 'approved' AND admin_actor_account_id IS NULL AND user_actor_id IS NULL)
  );
ALTER TABLE teacher_profiles DROP CONSTRAINT teacher_profiles_creator_check,
  DROP COLUMN created_by_signup_approval_id,
  ADD CONSTRAINT teacher_profiles_creator_check CHECK (num_nonnulls(created_by_operator_id, created_by_admin_account_id) = 1);
ALTER TABLE admin_signup_approvals DROP COLUMN recipient_email, DROP COLUMN code_encrypted,
  ALTER COLUMN issued_by_admin_account_id SET NOT NULL;
DROP TABLE mail_delivery_logs, mail_templates;
