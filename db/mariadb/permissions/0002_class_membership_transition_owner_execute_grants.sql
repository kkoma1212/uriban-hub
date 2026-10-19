-- T-HUB-62 phase-0002 transition-routine owner execution envelope.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- MariaDB 11.4 checks EXECUTE for the SQL SECURITY DEFINER identity when a
-- transition routine is entered. Because these routines are created by the
-- migration administrator with a foreign locked definer, the owner does not
-- receive automatic routine privileges. Grant the passwordless, ACCOUNT LOCK
-- owner only the twelve public transition entry points after all bodies exist.
-- Runtime identities receive nothing here; their separate activation draft
-- remains excluded from the phase-2 QA project.

GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.create_class_with_teacher_and_invite
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.archive_class
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.rotate_class_invite
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.request_class_membership
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.cancel_class_membership_request
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.leave_class
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.approve_class_member
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.reject_class_member
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.remove_class_member
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.allow_class_member_rejoin
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.delete_user_account
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.transfer_class_teacher
  TO 'classhub_routine'@'%';
