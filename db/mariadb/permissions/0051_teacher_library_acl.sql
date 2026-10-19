-- Activate together with the teacher library module; leave the installation baseline intact.
-- 자료는 고치지 않는다: 담기·보기·지우기만 허용한다.
GRANT SELECT, INSERT, DELETE ON classhub_mariadb_phase1_dev.teacher_library_items TO 'classhub_app'@'%';
