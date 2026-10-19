-- 관리자 로그인 세션 강제 종료(2026-09-30). 관리자 작업 기록이 받는 동작·대상 목록에
-- 'admin.session.revoked'와 'session'만 더한다(기존 값·다른 열·표·권한 변경 없음).
-- 두 검사는 열 정의에 붙은 이름 없는 검사라 열을 같은 정의로 다시 선언해 바꾼다.
-- 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인(원장 98).
ALTER TABLE admin_operation_audit_logs
  MODIFY COLUMN action LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (action IN (
    'admin.account.created',
    'admin.account.status_changed',
    'admin.account.roles_changed',
    'admin.account.credentials_reset',
    'admin.account.password_changed',
    'admin.account.mfa_reset',
    'admin.signup_approval.issued',
    'admin.signup_approval.reissued',
    'admin.signup_approval.revoked',
    'admin.user.status_changed',
    'admin.user.password_reset_issued',
    'admin.member.status_changed',
    'admin.inquiry.updated',
    'admin.terms.created',
    'admin.terms.published',
    'admin.terms.retired',
    'admin.system_state.updated',
    'admin.session.revoked'
  )),
  MODIFY COLUMN target_type LONGTEXT COLLATE utf8mb4_nopad_bin NOT NULL CHECK (
    target_type IN (
      'admin_account', 'signup_approval', 'user', 'member', 'inquiry',
      'terms_version', 'system_state', 'session'
    )
  );
