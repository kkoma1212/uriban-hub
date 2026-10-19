-- Locked owner only; application and operator runtime accounts receive nothing here.
GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.transfer_class_teacher_checked
  TO 'classhub_routine'@'%';
