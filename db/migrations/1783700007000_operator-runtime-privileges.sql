-- Up Migration

-- Operator commands must never inherit the schema-owner privileges used by
-- migrations. Keep new migrator-owned objects closed until a later command
-- adds an explicit, reviewed grant for classhub_operator.
ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM classhub_operator;
ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM classhub_operator;

-- Remove any historical broad grants before rebuilding the exact whitelist.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM classhub_operator;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM classhub_operator;

-- The bootstrap command can only inspect operator state, insert the first
-- credential, and return its generated identifier. It cannot update, revoke,
-- delete, or read operator email addresses.
GRANT SELECT (id, credential_hash, status, revoked_at),
  INSERT (email_normalized, credential_hash)
  ON operators TO classhub_operator;

-- The currently implemented importer validates only school identity and owns
-- only seed meal rows. Teacher, class, member, user, and school mutation remain
-- unavailable until their own operator commands are implemented.
GRANT SELECT (edu_office_code, school_code)
  ON schools TO classhub_operator;
GRANT SELECT (id, edu_office_code, school_code, meal_date, meal_type, menu_json),
  INSERT (
    edu_office_code,
    school_code,
    meal_date,
    meal_type,
    menu_json,
    source,
    source_updated_at
  ),
  UPDATE (menu_json, source, source_updated_at, updated_at),
  DELETE
  ON meals TO classhub_operator;

GRANT INSERT (
  run_id,
  operator_id,
  file_name,
  checksum,
  inserted_count,
  updated_count,
  deleted_count,
  skipped_count,
  failed_count,
  result,
  error_json,
  started_at,
  completed_at
) ON meal_import_logs TO classhub_operator;

GRANT INSERT (
  actor_type,
  operator_id,
  action,
  target_type,
  target_id,
  before_json,
  after_json,
  checksum,
  run_id
) ON operator_audit_logs TO classhub_operator;

GRANT USAGE ON SEQUENCE
  operators_id_seq,
  meals_id_seq,
  meal_import_logs_id_seq,
  operator_audit_logs_id_seq
  TO classhub_operator;

-- Down Migration

-- Leave the provisioned login role inert. Dropping a role is an external
-- credential lifecycle action and is intentionally not part of a schema down.
REVOKE SELECT (id, credential_hash, status, revoked_at),
  INSERT (email_normalized, credential_hash)
  ON operators FROM classhub_operator;
REVOKE SELECT (edu_office_code, school_code)
  ON schools FROM classhub_operator;
REVOKE SELECT (id, edu_office_code, school_code, meal_date, meal_type, menu_json),
  INSERT (
    edu_office_code,
    school_code,
    meal_date,
    meal_type,
    menu_json,
    source,
    source_updated_at
  ),
  UPDATE (menu_json, source, source_updated_at, updated_at),
  DELETE
  ON meals FROM classhub_operator;
REVOKE INSERT (
  run_id,
  operator_id,
  file_name,
  checksum,
  inserted_count,
  updated_count,
  deleted_count,
  skipped_count,
  failed_count,
  result,
  error_json,
  started_at,
  completed_at
) ON meal_import_logs FROM classhub_operator;
REVOKE INSERT (
  actor_type,
  operator_id,
  action,
  target_type,
  target_id,
  before_json,
  after_json,
  checksum,
  run_id
) ON operator_audit_logs FROM classhub_operator;
REVOKE USAGE ON SEQUENCE
  operators_id_seq,
  meals_id_seq,
  meal_import_logs_id_seq,
  operator_audit_logs_id_seq
  FROM classhub_operator;
