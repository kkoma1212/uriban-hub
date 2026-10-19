-- Up Migration

-- 교사가 학교 이메일 접근을 잃으면 계정과 학급 데이터에 영구히 닿을 수 없다.
-- PASSWORD_RESET_ENABLED가 기본 false이고 provision-teacher는 멱등 no-op이라
-- 재발급 경로가 없었다(2026-08-05 DEC-BLK-04 결정).
--
-- 마이그레이션 7000의 주석이 정한 절차대로, reset-teacher-password 명령에
-- 필요한 최소 컬럼만 명시적으로 연다. 다음을 의도적으로 제외한다.
--   - users의 email_normalized/display_name UPDATE (신원 변조 방지)
--   - teacher_profiles의 status UPDATE (revoked 교사 부활 방지)
--   - sessions의 SELECT (세션 토큰 해시 열람 차단)
--   - DELETE (어떤 테이블도 삭제 불가)

-- users를 UPDATE하면 지연 제약 트리거 users_teacher_invariants가 COMMIT에 깨어나
-- class_members를 읽는다(마이그 1000). 지금까지는 운영자가 users를 UPDATE할 일이
-- 없어 드러나지 않았고, 이 마이그레이션이 그 첫 경로를 연다.
-- 마이그 10000이 짝꿍 트리거(enforce_profile_teacher_invariants)에 쓴 처방을 그대로
-- 적용한다 — 운영자에게 class_members 가시성을 넓게 주는 대신 그 트리거 본문만
-- 소유자 권한으로 돌린다. 이름 해석을 고정하고 직접 EXECUTE를 닫는 두 줄이
-- SECURITY DEFINER의 권한 상승 경로를 막으므로 세 줄은 한 묶음이다.
ALTER FUNCTION enforce_user_teacher_invariants() SECURITY DEFINER;
ALTER FUNCTION enforce_user_teacher_invariants()
  SET search_path TO pg_catalog, public;
REVOKE EXECUTE ON FUNCTION enforce_user_teacher_invariants() FROM PUBLIC;

-- 비밀번호만 갈아끼운다. 이메일·표시명은 여전히 바꿀 수 없다.
GRANT UPDATE (password_hash) ON users TO classhub_operator;

-- 임시 비밀번호 상태만 갱신한다. status는 여전히 읽기 전용이라
-- revoked 교사를 되살릴 수 없다.
GRANT UPDATE (temporary_password_must_change, temporary_password_expires_at)
  ON teacher_profiles TO classhub_operator;

-- 재발급은 계정 탈취 대응이기도 하므로 살아 있는 세션을 끊어야 한다.
-- revoked_at만 쓸 수 있고 session_hash/csrf_token_hash는 읽지도 못한다.
GRANT SELECT (user_id, revoked_at),
  UPDATE (revoked_at)
  ON sessions TO classhub_operator;

-- 재발급 사실을 감사 로그에 남기려면 action 허용 목록에 추가해야 한다.
-- 나머지 액션은 마이그레이션 13000의 목록을 그대로 유지한다.
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.password_reset', 'teacher.transferred', 'teacher.revoked',
    'class.suspended', 'class.archived', 'class.reactivated',
    'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'retention.executed'
  ));

-- Down Migration

REVOKE SELECT (user_id, revoked_at),
  UPDATE (revoked_at)
  ON sessions FROM classhub_operator;
REVOKE UPDATE (temporary_password_must_change, temporary_password_expires_at)
  ON teacher_profiles FROM classhub_operator;
REVOKE UPDATE (password_hash) ON users FROM classhub_operator;

-- 트리거를 호출자 권한으로 되돌린다. 마이그 10000이 소유한
-- enforce_profile_teacher_invariants 쪽 설정은 건드리지 않는다.
ALTER FUNCTION enforce_user_teacher_invariants() SECURITY INVOKER;
ALTER FUNCTION enforce_user_teacher_invariants() RESET search_path;
GRANT EXECUTE ON FUNCTION enforce_user_teacher_invariants() TO PUBLIC;

-- 액션 허용 목록도 되돌린다. 이걸 빠뜨리면 롤백 뒤에도 'teacher.password_reset'이
-- 계속 허용돼 "완전 원복"이 아니게 된다. 목록은 마이그 13000의 것 그대로다.
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.transferred', 'teacher.revoked', 'class.suspended', 'class.archived',
    'class.reactivated', 'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'retention.executed'
  ));
