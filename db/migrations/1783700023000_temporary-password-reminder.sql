-- Up Migration

-- 교사가 임시 비밀번호를 받고 로그인하지 않은 채 72시간이 지나면 비밀번호가
-- 만료되고, 그때부터는 운영자 재발급 말고는 길이 없다(2026-08-01 감사 P0 권장수정 3).
-- 만료 전에 한 번 알려주면 그 문의 자체가 줄어든다.
--
-- 발송 여부를 기록할 자리가 없으면 스케줄러가 도는 주기마다 같은 교사에게
-- 반복 발송된다. 감사 로그 조회로 대신할 수도 있으나 로그 보존기간이 짧아지면
-- 조용히 재발송되므로, 상태를 프로필에 직접 둔다.
ALTER TABLE teacher_profiles
  ADD COLUMN temporary_password_reminder_sent_at TIMESTAMPTZ;

-- 발송 대상 판별에 필요한 컬럼만 연다. 임시 비밀번호 해시나 status 변경 권한은
-- 주지 않으므로 이 역할은 교사 계정을 되살리거나 비밀번호를 바꿀 수 없다.
GRANT SELECT (
    user_id,
    status,
    temporary_password_must_change,
    temporary_password_expires_at,
    temporary_password_reminder_sent_at
  ),
  UPDATE (temporary_password_reminder_sent_at)
  ON teacher_profiles TO classhub_retention;

-- ⚠️ 메일을 보내려면 주소를 읽어야 하므로 이 역할이 교사 이메일을 보게 된다.
-- 이 저장소는 컬럼 단위로 권한을 좁혀왔으니 범위를 분명히 해둔다: 발송 대상을
-- 거르는 데 필요한 네 컬럼뿐이고, 비밀번호 해시·표시명·삭제 이력은 제외한다.
-- 쓰기 권한은 어떤 컬럼에도 주지 않는다.
GRANT SELECT (id, email_normalized, is_active, deleted_at)
  ON users TO classhub_retention;

-- Down Migration

REVOKE SELECT (id, email_normalized, is_active, deleted_at)
  ON users FROM classhub_retention;
REVOKE SELECT (
    user_id,
    status,
    temporary_password_must_change,
    temporary_password_expires_at,
    temporary_password_reminder_sent_at
  ),
  UPDATE (temporary_password_reminder_sent_at)
  ON teacher_profiles FROM classhub_retention;

ALTER TABLE teacher_profiles
  DROP COLUMN temporary_password_reminder_sent_at;
