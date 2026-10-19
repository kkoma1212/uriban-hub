-- T-HUB-62 phase-0002 helper/trigger security envelope draft.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- Preconditions:
--   1. `0002_class_membership_definer_account.sql` provisioned the locked owner.
--   2. Phase 0001 and `0002_class_membership.sql` created the referenced tables.
--   3. This file runs before `0002_class_invariant_boundary.sql` so MariaDB
--      compiles each SQL SECURITY DEFINER body with its exact read envelope.
--
-- These are the exact reads required by the helpers, history trigger, and the
-- twelve reviewed invariant-core routines. The locked owner alone can invoke
-- the three internal helpers. Their post-create EXECUTE grants live in the
-- separate helper-execute file; no runtime identity receives helper EXECUTE.
-- Invariant-bearing writes live in the separate definer DML draft.

GRANT SELECT (
    id,
    name,
    academic_year,
    grade,
    edu_office_code,
    school_code,
    name_normalized,
    status,
    row_version
  )
  ON classhub_mariadb_phase1_dev.classes
  TO 'classhub_routine'@'%';
GRANT SELECT (id, class_id, user_id, role, status, row_version, current_user_id)
  ON classhub_mariadb_phase1_dev.class_members
  TO 'classhub_routine'@'%';
GRANT SELECT (id, is_active, deleted_at, email_verified_at)
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_routine'@'%';
GRANT SELECT (user_id, status, temporary_password_must_change)
  ON classhub_mariadb_phase1_dev.teacher_profiles
  TO 'classhub_routine'@'%';
GRANT SELECT (id, class_id, code, expires_at, revoked_at)
  ON classhub_mariadb_phase1_dev.class_invite_codes
  TO 'classhub_routine'@'%';
GRANT SELECT (edu_office_code, school_code, school_kind)
  ON classhub_mariadb_phase1_dev.schools
  TO 'classhub_routine'@'%';

-- MariaDB checks both trigger activation and NEW/OLD column reads in the
-- definer security context. Grant only the seven columns inspected by the
-- append-only validation trigger; reason/created_at remain outside its read
-- envelope.
GRANT SELECT (
    member_id,
    class_id,
    from_status,
    to_status,
    actor_user_id,
    actor_member_id,
    actor_operator_id
  )
  ON classhub_mariadb_phase1_dev.class_member_status_history
  TO 'classhub_routine'@'%';
GRANT TRIGGER
  ON classhub_mariadb_phase1_dev.class_member_status_history
  TO 'classhub_routine'@'%';
