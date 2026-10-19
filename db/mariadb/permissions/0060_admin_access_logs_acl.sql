-- 관리자 접속기록(원장 102). 0060 표 다음에만 적용한다.
-- 앱: 조회할 때 넣고, 월 점검 화면에서 읽는다. 고치거나 지우지 못하게 UPDATE·DELETE는 주지 않는다.
-- 2년 지난 기록 삭제(정리 계정 권한)는 2028년 이전에 별도 승인으로 더한다.
GRANT SELECT, INSERT ON classhub_mariadb_phase1_dev.admin_access_logs TO 'classhub_app'@'%';
