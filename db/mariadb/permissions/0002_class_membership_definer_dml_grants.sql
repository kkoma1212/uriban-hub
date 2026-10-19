-- T-HUB-62 phase-0002 invariant-core definer DML envelope draft.
--
-- ISOLATED SYNTHETIC QA ONLY. DO NOT APPLY TO A SHARED OR PRODUCTION DATABASE.
--
-- Preconditions: the locked classhub_routine account, all routine bodies, and
-- the read/helper envelope have passed the MariaDB 11.4 parser and ACL suite.
-- There is deliberately no DELETE, GRANT OPTION, schema-wide, role, proxy,
-- audit/idempotency, teacher_profiles, schools, operators, or future-table DML.

GRANT INSERT (
    name,
    academic_year,
    grade,
    edu_office_code,
    school_code,
    expected_student_count,
    created_by_user_id,
    created_at,
    updated_at
  ),
  UPDATE (
    status,
    row_version,
    suspended_reason,
    suspended_at,
    suspended_by_operator_id,
    archived_at,
    archived_by_user_id,
    archived_by_operator_id,
    updated_at
  )
  ON classhub_mariadb_phase1_dev.classes
  TO 'classhub_routine'@'%';

GRANT INSERT (
    class_id,
    user_id,
    role,
    status,
    status_changed_at,
    created_at,
    updated_at
  ),
  UPDATE (
    status,
    student_number,
    display_name_in_class,
    row_version,
    status_changed_at,
    updated_at
  )
  ON classhub_mariadb_phase1_dev.class_members
  TO 'classhub_routine'@'%';

GRANT INSERT (
    member_id,
    class_id,
    from_status,
    to_status,
    actor_user_id,
    actor_member_id,
    actor_operator_id,
    reason,
    created_at
  )
  ON classhub_mariadb_phase1_dev.class_member_status_history
  TO 'classhub_routine'@'%';

GRANT INSERT (
    class_id,
    code,
    expires_at,
    created_by_member_id,
    created_at
  ),
  UPDATE (
    revoked_at,
    revoked_by_member_id,
    revoked_by_operator_id,
    revoke_reason
  )
  ON classhub_mariadb_phase1_dev.class_invite_codes
  TO 'classhub_routine'@'%';

GRANT UPDATE (
    email_normalized,
    display_name,
    password_hash,
    is_active,
    failed_login_attempts,
    locked_until,
    password_last_changed_at,
    updated_at,
    deleted_at,
    anonymized_at
  )
  ON classhub_mariadb_phase1_dev.users
  TO 'classhub_routine'@'%';
