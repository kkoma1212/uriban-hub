-- Up Migration

-- Prepared only. Apply to an isolated database until explicit operating approval.
-- 관리자 개인정보 조회 접속기록(2026-10-03 사용자 결정). MariaDB 0060과 같은 구조.

CREATE TABLE admin_access_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_account_id BIGINT NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  access_kind VARCHAR(48) NOT NULL,
  searched BOOLEAN NOT NULL DEFAULT FALSE,
  subject_type VARCHAR(24) NOT NULL,
  subject_count INTEGER NOT NULL,
  subject_ids JSONB NOT NULL,
  client_ip VARCHAR(45) NOT NULL,
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_access_logs_kind_check CHECK (access_kind IN (
    'people.list', 'users.list', 'members.list', 'classes.list',
    'class_audit.list', 'operation_audit.list', 'auth_audit.list', 'terms_consents.list',
    'inquiries.list', 'sessions.list', 'signup_approvals.list', 'admin_accounts.list',
    'signup_account.lookup'
  )),
  CONSTRAINT admin_access_logs_subject_type_check CHECK (subject_type IN (
    'user', 'member', 'class', 'admin_account', 'inquiry', 'session', 'audit_log', 'signup_approval'
  )),
  CONSTRAINT admin_access_logs_count_check CHECK (subject_count >= 0),
  CONSTRAINT admin_access_logs_subjects_check CHECK (jsonb_typeof(subject_ids) = 'array'),
  CONSTRAINT admin_access_logs_ip_check CHECK (char_length(client_ip) BETWEEN 1 AND 45)
);
CREATE INDEX admin_access_logs_created_index ON admin_access_logs (created_at, id);
CREATE INDEX admin_access_logs_admin_index ON admin_access_logs (admin_account_id, created_at);
GRANT SELECT, INSERT ON admin_access_logs TO classhub_app;

-- Down Migration
-- 접속기록은 법정 보관 기록이다. 운영에서는 되돌리기 전에 내보내 보관한 뒤 실행한다.
REVOKE ALL ON admin_access_logs FROM classhub_app;
DROP TABLE admin_access_logs;
