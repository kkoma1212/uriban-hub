-- Up Migration

CREATE TABLE school_schedule_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  edu_office_code TEXT NOT NULL,
  school_code TEXT NOT NULL,
  academic_year INTEGER NOT NULL,
  event_date DATE NOT NULL,
  event_name TEXT NOT NULL,
  event_content TEXT,
  school_day_type TEXT NOT NULL,
  grade_mask SMALLINT NOT NULL,
  source_loaded_on DATE NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (edu_office_code, school_code)
    REFERENCES schools (edu_office_code, school_code) ON DELETE RESTRICT,
  CONSTRAINT school_schedule_events_natural_key UNIQUE (
    edu_office_code,
    school_code,
    academic_year,
    event_date,
    event_name,
    grade_mask
  ),
  CONSTRAINT school_schedule_events_year_check CHECK (
    academic_year BETWEEN 2020 AND 2100
  ),
  CONSTRAINT school_schedule_events_name_check CHECK (
    char_length(btrim(event_name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT school_schedule_events_content_check CHECK (
    event_content IS NULL OR char_length(event_content) <= 2000
  ),
  CONSTRAINT school_schedule_events_day_type_check CHECK (
    char_length(btrim(school_day_type)) BETWEEN 1 AND 30
  ),
  CONSTRAINT school_schedule_events_grade_mask_check CHECK (
    grade_mask BETWEEN 1 AND 63
  )
);

CREATE INDEX school_schedule_events_school_date_index
  ON school_schedule_events (
    edu_office_code,
    school_code,
    academic_year,
    event_date,
    id
  );

CREATE TABLE school_schedule_import_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE,
  operator_id BIGINT NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  inserted_count INTEGER NOT NULL,
  updated_count INTEGER NOT NULL,
  deleted_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_json JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT school_schedule_import_logs_checksum_check CHECK (
    checksum ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT school_schedule_import_logs_counts_check CHECK (
    inserted_count >= 0
    AND updated_count >= 0
    AND deleted_count = 0
    AND skipped_count >= 0
    AND failed_count >= 0
  ),
  CONSTRAINT school_schedule_import_logs_result_check CHECK (
    result IN ('success', 'failed')
  ),
  CONSTRAINT school_schedule_import_logs_time_check CHECK (
    started_at <= completed_at
  )
);

ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.transferred', 'teacher.revoked', 'class.suspended', 'class.archived',
    'class.reactivated', 'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'retention.executed'
  )),
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['operator_id', 'status'])
        AND jsonb_has_only_keys(after_json, ARRAY['operator_id', 'status'])
      WHEN action LIKE 'teacher.%' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
      WHEN action LIKE 'class.%' THEN
        jsonb_has_only_keys(
          before_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
      WHEN action LIKE 'user.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['user_id', 'is_active', 'reason'])
        AND jsonb_has_only_keys(after_json, ARRAY['user_id', 'is_active', 'reason'])
      WHEN action IN (
        'school.imported',
        'meal.imported',
        'school_schedule.imported'
      ) THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  );

GRANT SELECT ON school_schedule_events TO classhub_app;

GRANT SELECT (
    id,
    edu_office_code,
    school_code,
    academic_year,
    event_date,
    event_name,
    event_content,
    school_day_type,
    grade_mask,
    source_loaded_on
  ),
  INSERT (
    edu_office_code,
    school_code,
    academic_year,
    event_date,
    event_name,
    event_content,
    school_day_type,
    grade_mask,
    source_loaded_on,
    source_updated_at
  ),
  UPDATE (
    event_content,
    school_day_type,
    source_loaded_on,
    source_updated_at,
    updated_at
  )
  ON school_schedule_events TO classhub_operator;

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
) ON school_schedule_import_logs TO classhub_operator;

GRANT USAGE ON SEQUENCE
  school_schedule_events_id_seq,
  school_schedule_import_logs_id_seq
  TO classhub_operator;

GRANT SELECT, DELETE ON school_schedule_import_logs TO classhub_retention;

-- Down Migration

DO $neis_school_schedule_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM school_schedule_events)
    OR EXISTS (SELECT 1 FROM school_schedule_import_logs)
    OR EXISTS (
      SELECT 1
      FROM operator_audit_logs
      WHERE action = 'school_schedule.imported'
    )
  THEN
    RAISE EXCEPTION
      'NEIS school schedule rollback requires events, import logs, and audit rows to be empty';
  END IF;
END
$neis_school_schedule_rollback_guard$;

REVOKE SELECT, DELETE ON school_schedule_import_logs FROM classhub_retention;

REVOKE USAGE ON SEQUENCE
  school_schedule_events_id_seq,
  school_schedule_import_logs_id_seq
  FROM classhub_operator;

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
) ON school_schedule_import_logs FROM classhub_operator;

REVOKE SELECT (
    id,
    edu_office_code,
    school_code,
    academic_year,
    event_date,
    event_name,
    event_content,
    school_day_type,
    grade_mask,
    source_loaded_on
  ),
  INSERT (
    edu_office_code,
    school_code,
    academic_year,
    event_date,
    event_name,
    event_content,
    school_day_type,
    grade_mask,
    source_loaded_on,
    source_updated_at
  ),
  UPDATE (
    event_content,
    school_day_type,
    source_loaded_on,
    source_updated_at,
    updated_at
  )
  ON school_schedule_events FROM classhub_operator;

REVOKE SELECT ON school_schedule_events FROM classhub_app;

ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.transferred', 'teacher.revoked', 'class.suspended', 'class.archived',
    'class.reactivated', 'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'retention.executed'
  )),
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['operator_id', 'status'])
        AND jsonb_has_only_keys(after_json, ARRAY['operator_id', 'status'])
      WHEN action LIKE 'teacher.%' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
      WHEN action LIKE 'class.%' THEN
        jsonb_has_only_keys(
          before_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
      WHEN action LIKE 'user.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['user_id', 'is_active', 'reason'])
        AND jsonb_has_only_keys(after_json, ARRAY['user_id', 'is_active', 'reason'])
      WHEN action IN ('school.imported', 'meal.imported') THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  );

DROP TABLE school_schedule_import_logs;
DROP TABLE school_schedule_events;
