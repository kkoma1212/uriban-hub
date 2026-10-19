-- 관리자 작업 기록(2년)·탈퇴·철회 동의 증빙(1년) 자동 삭제(원장 105, 2026-10-03 사용자 승인, 총검수 I3-01).
-- 원장 104(메일 발송 기록) 다음에만 적용한다. 정리 계정이 기간 지난 기록을 세고 지운다.
-- 권한 검사가 정확히 일치해야 하므로 적용과 함께 RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED=true를 적는다.
-- 되돌리기는 apply-audit-consent-retention-native.mjs --rollback이 맡는다.
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.admin_operation_audit_logs TO 'classhub_retention'@'%';
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.user_consents TO 'classhub_retention'@'%';
