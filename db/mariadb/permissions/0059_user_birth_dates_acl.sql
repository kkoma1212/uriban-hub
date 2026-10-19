-- 생년월일(원장 100). 0059 칸·트리거 다음에만 적용한다.
-- 앱: 가입 때 넣고, 설정에서 고친다. 트리거 소유자: 익명 처리 여부를 읽고 두 칸을 비운다(행 수정 권한 없음).
GRANT INSERT (birth_date, birthday_shared), UPDATE (birth_date, birthday_shared)
  ON classhub_mariadb_phase1_dev.users TO 'classhub_app'@'%';
GRANT SELECT (anonymized_at), UPDATE (birth_date, birthday_shared)
  ON classhub_mariadb_phase1_dev.users TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.users TO 'classhub_routine'@'%';
