USE classhub_mariadb_phase1_dev;
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE admin_signup_approvals
  MODIFY COLUMN issued_by_admin_account_id BIGINT NULL,
  ADD COLUMN recipient_email VARCHAR(320) COLLATE utf8mb4_nopad_bin,
  ADD COLUMN code_encrypted LONGTEXT COLLATE utf8mb4_nopad_bin;
ALTER TABLE teacher_profiles
  ADD COLUMN created_by_signup_approval_id UUID,
  ADD CONSTRAINT teacher_profiles_signup_creator_fk FOREIGN KEY (created_by_signup_approval_id) REFERENCES admin_signup_approvals(id) ON DELETE RESTRICT,
  DROP CONSTRAINT teacher_profiles_creator_check,
  ADD CONSTRAINT teacher_profiles_creator_check CHECK (
    (created_by_operator_id IS NOT NULL) + (created_by_admin_account_id IS NOT NULL) + (created_by_signup_approval_id IS NOT NULL) = 1
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
  `key` VARCHAR(64) COLLATE utf8mb4_nopad_bin NOT NULL PRIMARY KEY,
  title VARCHAR(120) COLLATE utf8mb4_nopad_bin NOT NULL,
  introduction LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  footer LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL,
  button_label VARCHAR(40) COLLATE utf8mb4_nopad_bin NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_by_admin_account_id BIGINT NOT NULL,
  CONSTRAINT mail_templates_key_check CHECK (`key` = 'signup_verification'),
  CONSTRAINT mail_templates_admin_fk FOREIGN KEY (updated_by_admin_account_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE mail_delivery_logs (
  id UUID NOT NULL PRIMARY KEY,
  recipient_email VARCHAR(320) COLLATE utf8mb4_nopad_bin NOT NULL,
  subject VARCHAR(200) COLLATE utf8mb4_nopad_bin NOT NULL,
  status VARCHAR(16) COLLATE utf8mb4_nopad_bin NOT NULL,
  failure_code VARCHAR(64) COLLATE utf8mb4_nopad_bin,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  completed_at DATETIME(6),
  CONSTRAINT mail_delivery_logs_status_check CHECK (status IN ('pending', 'accepted', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX mail_delivery_logs_created_index ON mail_delivery_logs(created_at DESC, id DESC);
CREATE INDEX mail_delivery_logs_recipient_index ON mail_delivery_logs(recipient_email, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON classhub_mariadb_phase1_dev.mail_templates TO 'classhub_app'@'%';
GRANT SELECT, INSERT, UPDATE (status, failure_code, completed_at) ON classhub_mariadb_phase1_dev.mail_delivery_logs TO 'classhub_app'@'%';
GRANT INSERT (recipient_email, code_encrypted) ON classhub_mariadb_phase1_dev.admin_signup_approvals TO 'classhub_app'@'%';
GRANT INSERT (created_by_signup_approval_id) ON classhub_mariadb_phase1_dev.teacher_profiles TO 'classhub_app'@'%';
