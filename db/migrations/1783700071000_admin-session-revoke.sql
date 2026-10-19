-- Up Migration

-- Prepared only. Apply to an isolated database until explicit operating approval.
-- 관리자 로그인 세션 강제 종료: 관리자 작업 기록의 동작·대상 목록에 한 값씩만 더한다.

ALTER TABLE admin_operation_audit_logs
  DROP CONSTRAINT admin_operation_audit_logs_action_check,
  ADD CONSTRAINT admin_operation_audit_logs_action_check CHECK (action IN (
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
  DROP CONSTRAINT admin_operation_audit_logs_target_type_check,
  ADD CONSTRAINT admin_operation_audit_logs_target_type_check CHECK (
    target_type IN (
      'admin_account', 'signup_approval', 'user', 'member', 'inquiry',
      'terms_version', 'system_state', 'session'
    )
  );

-- Down Migration
-- Keep the expanded audit action allowlist: history is append-only and may already hold
-- 'admin.session.revoked' rows (same rule as the admin passkey migration).
