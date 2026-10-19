-- Up Migration

-- Extend the dedicated operator role only for the reviewed school import and
-- teacher provisioning commands. Historical meal/bootstrap grants remain
-- owned by migration 7000.

-- The deferred teacher-profile invariant trigger reads class membership even
-- for a newly provisioned teacher with no class. Run only that trigger body as
-- its migration owner instead of granting the operator role broad membership
-- visibility. Pin name resolution and close direct EXECUTE to prevent temp
-- trigger reuse by runtime roles.
ALTER FUNCTION enforce_profile_teacher_invariants() SECURITY DEFINER;
ALTER FUNCTION enforce_profile_teacher_invariants()
  SET search_path TO pg_catalog, public;
REVOKE EXECUTE ON FUNCTION enforce_profile_teacher_invariants() FROM PUBLIC;

GRANT SELECT (school_name, school_kind, region_name, edu_office_name),
  INSERT (
    edu_office_code,
    school_code,
    school_name,
    school_kind,
    region_name,
    edu_office_name
  ),
  UPDATE (
    school_name,
    school_kind,
    region_name,
    edu_office_name,
    updated_at
  )
  ON schools TO classhub_operator;

-- School-kind changes inspect existing grades. The command cannot read class
-- identity, names, lifecycle state, membership, or mutate any class row.
GRANT SELECT (edu_office_code, school_code, grade)
  ON classes TO classhub_operator;

GRANT INSERT (
  run_id,
  operator_id,
  file_name,
  checksum,
  inserted_count,
  updated_count,
  skipped_count,
  failed_count,
  result,
  error_json,
  started_at,
  completed_at
) ON school_import_logs TO classhub_operator;

-- Teacher provisioning is create-only. Existing rows are visible only far
-- enough to enforce fail-closed email idempotency and terminal revoke state.
GRANT SELECT (id, email_normalized, is_active, deleted_at),
  INSERT (email_normalized, display_name, password_hash, email_verified_at)
  ON users TO classhub_operator;
GRANT SELECT (user_id, status),
  INSERT (
    user_id,
    temporary_password_must_change,
    temporary_password_expires_at,
    created_by_operator_id
  )
  ON teacher_profiles TO classhub_operator;

GRANT USAGE ON SEQUENCE
  users_id_seq,
  teacher_profiles_id_seq,
  school_import_logs_id_seq
  TO classhub_operator;

-- Down Migration

-- Revoke only privileges introduced above. In particular, keep the school-key
-- SELECT and meal/bootstrap grants owned by migration 7000 intact.
ALTER FUNCTION enforce_profile_teacher_invariants() SECURITY INVOKER;
ALTER FUNCTION enforce_profile_teacher_invariants() RESET search_path;
GRANT EXECUTE ON FUNCTION enforce_profile_teacher_invariants() TO PUBLIC;

REVOKE SELECT (school_name, school_kind, region_name, edu_office_name),
  INSERT (
    edu_office_code,
    school_code,
    school_name,
    school_kind,
    region_name,
    edu_office_name
  ),
  UPDATE (
    school_name,
    school_kind,
    region_name,
    edu_office_name,
    updated_at
  )
  ON schools FROM classhub_operator;
REVOKE SELECT (edu_office_code, school_code, grade)
  ON classes FROM classhub_operator;
REVOKE INSERT (
  run_id,
  operator_id,
  file_name,
  checksum,
  inserted_count,
  updated_count,
  skipped_count,
  failed_count,
  result,
  error_json,
  started_at,
  completed_at
) ON school_import_logs FROM classhub_operator;
REVOKE SELECT (id, email_normalized, is_active, deleted_at),
  INSERT (email_normalized, display_name, password_hash, email_verified_at)
  ON users FROM classhub_operator;
REVOKE SELECT (user_id, status),
  INSERT (
    user_id,
    temporary_password_must_change,
    temporary_password_expires_at,
    created_by_operator_id
  )
  ON teacher_profiles FROM classhub_operator;
REVOKE USAGE ON SEQUENCE
  users_id_seq,
  teacher_profiles_id_seq,
  school_import_logs_id_seq
  FROM classhub_operator;
