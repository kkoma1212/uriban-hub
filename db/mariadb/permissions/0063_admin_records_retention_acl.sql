-- 관리자 기록 보관 기간(원장 106, 2026-10-04 사용자 결정, 처리방침 4장). 원장 105 다음에만 적용한다.
-- 끝난 가입 승인: 30일 뒤 이메일 원문·암호화 코드만 비우고(처리 기록이 행을 붙잡고 있어서) 행은 처리 기록과
-- 함께 2년 뒤 지운다. 폐기·사용한 패스키·복구 코드는 30일, 처리 끝난 문의는 1년 뒤 지운다.
-- 권한 검사가 정확히 일치해야 하므로 적용과 함께 RETENTION_ADMIN_RECORDS_GRANT_INSTALLED=true를 적는다.
-- 되돌리기는 apply-admin-records-retention-native.mjs --rollback이 맡는다.
GRANT SELECT, UPDATE (recipient_email, code_encrypted), DELETE ON classhub_mariadb_phase1_dev.admin_signup_approvals TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.admin_signup_approval_events TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.admin_passkeys TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.admin_recovery_codes TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.admin_inquiries TO 'classhub_retention'@'%';
