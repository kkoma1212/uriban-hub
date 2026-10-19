-- Up Migration

-- 재발급에 짧은 쿨다운을 두려면 직전 발급 시각을 알아야 한다. 별도 컬럼을 만들지
-- 않고 만료 시각에서 되돌려 구하므로(수명이 고정 상수라 정확하다) 그 컬럼을 읽을
-- 권한만 있으면 된다.
--
-- 마이그 10000은 읽기를 (user_id, status)로 좁혔고 22000은 임시 비밀번호 컬럼의
-- 쓰기만 열었다. 그래서 지금은 운영자가 자기가 쓴 값을 되읽지 못한다.
GRANT SELECT (temporary_password_expires_at)
  ON teacher_profiles TO classhub_operator;

-- Down Migration

REVOKE SELECT (temporary_password_expires_at)
  ON teacher_profiles FROM classhub_operator;
