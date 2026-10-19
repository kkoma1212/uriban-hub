-- 메일 발송 기록 1년 자동 삭제(원장 104, 2026-10-03 사용자 승인, 총검수 I5-04). 0042 표 다음에만 적용한다.
-- 정리 계정이 발송 요청 시각부터 1년 지난 기록을 세고 지운다. 권한 검사가 정확히 일치해야 하므로
-- 적용과 함께 .env.local에 RETENTION_MAIL_LOGS_GRANT_INSTALLED=true를 적는다.
-- 되돌리기는 apply-mail-log-retention-native.mjs --rollback이 맡는다.
GRANT SELECT, DELETE ON classhub_mariadb_phase1_dev.mail_delivery_logs TO 'classhub_retention'@'%';
