-- T-HUB-62 phase-0002 internal helper execution envelope draft.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- Apply only after `0002_class_invariant_boundary.sql` has created all three
-- helpers under the already-provisioned read envelope. The locked owner alone
-- may invoke them; no runtime login identity receives helper EXECUTE.

GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.assert_read_committed_session
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.lock_class_invariant_boundary
  TO 'classhub_routine'@'%';
GRANT EXECUTE
  ON PROCEDURE classhub_mariadb_phase1_dev.assert_class_invariants
  TO 'classhub_routine'@'%';
