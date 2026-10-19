-- 관리자 개인정보 조회 접속기록(2026-10-03 사용자 결정, 총검수 C2-01·I3-05·I2-01).
-- 개인정보의 안전성 확보조치 기준의 접속기록: 누가(관리자) · 언제 · 어디서(IP 원문, 사용자 결정) ·
-- 누구의 정보를(내부 번호만) · 무엇을(조회한 화면, 검색 여부). 검색어 원문은 남기지 않는다.
-- 보관 2년(사용자 결정). 앱은 넣고 읽기만 한다(고치거나 지울 권한 없음).
-- 기존 표는 바꾸지 않는다(새 표 하나). 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인(원장 101).
CREATE TABLE admin_access_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  admin_account_id BIGINT NOT NULL,
  access_kind VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  searched BOOLEAN NOT NULL DEFAULT FALSE,
  subject_type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject_count INT NOT NULL,
  subject_ids JSON NOT NULL,
  client_ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id UUID NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT admin_access_logs_admin_fk FOREIGN KEY (admin_account_id)
    REFERENCES admin_accounts (id) ON DELETE RESTRICT,
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
  CONSTRAINT admin_access_logs_ip_check CHECK (CHAR_LENGTH(client_ip) BETWEEN 1 AND 45),
  INDEX admin_access_logs_created_index (created_at, id),
  INDEX admin_access_logs_admin_index (admin_account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
