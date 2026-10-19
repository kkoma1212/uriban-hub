-- T-HUB-64 MariaDB baseline phase 0008 (development only).
-- PostgreSQL source: 1783700013000_neis-school-schedules.sql (Up only).
-- Apply only to an isolated synthetic QA database; runtime ACLs remain separate.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE school_schedule_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  edu_office_code VARCHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  school_code VARCHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  academic_year INT NOT NULL,
  event_date DATE NOT NULL,
  -- The source limits trimmed length only; raw leading/trailing spaces remain significant.
  -- InnoDB implements this full-value long UNIQUE with its internal collision-checked hash.
  event_name LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  event_content TEXT,
  school_day_type LONGTEXT NOT NULL,
  grade_mask SMALLINT NOT NULL,
  source_loaded_on DATE NOT NULL,
  source_updated_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT school_schedule_events_school_fk
    FOREIGN KEY (edu_office_code, school_code)
    REFERENCES schools (edu_office_code, school_code) ON DELETE RESTRICT,
  CONSTRAINT school_schedule_events_natural_key UNIQUE (
    edu_office_code, school_code, academic_year, event_date, event_name, grade_mask
  ),
  CONSTRAINT school_schedule_events_year_check CHECK (
    academic_year BETWEEN 2020 AND 2100
  ),
  CONSTRAINT school_schedule_events_name_check CHECK (
    CHAR_LENGTH(TRIM(event_name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT school_schedule_events_content_check CHECK (
    event_content IS NULL OR CHAR_LENGTH(event_content) <= 2000
  ),
  CONSTRAINT school_schedule_events_day_type_check CHECK (
    CHAR_LENGTH(TRIM(school_day_type)) BETWEEN 1 AND 30
  ),
  CONSTRAINT school_schedule_events_grade_mask_check CHECK (
    grade_mask BETWEEN 1 AND 63
  ),
  INDEX school_schedule_events_school_date_index (
    edu_office_code, school_code, academic_year, event_date, id
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE school_schedule_import_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_id UUID NOT NULL,
  operator_id BIGINT NOT NULL,
  file_name LONGTEXT NOT NULL,
  checksum TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  inserted_count INT NOT NULL,
  updated_count INT NOT NULL,
  deleted_count INT NOT NULL,
  skipped_count INT NOT NULL,
  failed_count INT NOT NULL,
  result VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  error_json JSON,
  started_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT school_schedule_import_logs_run_unique UNIQUE (run_id),
  CONSTRAINT school_schedule_import_logs_operator_fk
    FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE RESTRICT,
  CONSTRAINT school_schedule_import_logs_checksum_check CHECK (
    OCTET_LENGTH(checksum) = 64 AND BINARY checksum REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT school_schedule_import_logs_counts_check CHECK (
    inserted_count >= 0
    AND updated_count >= 0
    AND deleted_count = 0
    AND skipped_count >= 0
    AND failed_count >= 0
  ),
  CONSTRAINT school_schedule_import_logs_result_check CHECK (
    BINARY result IN (BINARY 'success', BINARY 'failed')
  ),
  CONSTRAINT school_schedule_import_logs_time_check CHECK (
    started_at <= completed_at
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'operator.bootstrapped', BINARY 'operator.created', BINARY 'operator.revoked',
      BINARY 'operator.token_rotated', BINARY 'operator.credential_recovered',
      BINARY 'teacher.created', BINARY 'teacher.transferred', BINARY 'teacher.revoked',
      BINARY 'class.suspended', BINARY 'class.archived', BINARY 'class.reactivated',
      BINARY 'user.deactivated', BINARY 'user.reactivated', BINARY 'school.imported',
      BINARY 'meal.imported', BINARY 'school_schedule.imported', BINARY 'retention.executed'
    )
  ),
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        (
          before_json IS NULL OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS('["operator_id","status"]', JSON_KEYS(before_json)) = 1
          )
        ) AND (
          after_json IS NULL OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS('["operator_id","status"]', JSON_KEYS(after_json)) = 1
          )
        )
      WHEN action LIKE 'teacher.%' THEN
        (
          before_json IS NULL OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["teacher_user_id","teacher_profile_status","class_id","reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        ) AND (
          after_json IS NULL OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["teacher_user_id","teacher_profile_status","class_id","reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'class.%' THEN
        (
          before_json IS NULL OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","status","teacher_user_id","reason"]', JSON_KEYS(before_json)
            ) = 1
          )
        ) AND (
          after_json IS NULL OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","status","teacher_user_id","reason"]', JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'user.%' THEN
        (
          before_json IS NULL OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS('["user_id","is_active","reason"]', JSON_KEYS(before_json)) = 1
          )
        ) AND (
          after_json IS NULL OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS('["user_id","is_active","reason"]', JSON_KEYS(after_json)) = 1
          )
        )
      WHEN action IN ('school.imported', 'meal.imported', 'school_schedule.imported') THEN
        (
          before_json IS NULL OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        ) AND (
          after_json IS NULL OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      ELSE
        (
          before_json IS NULL OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS('["cutoff_at","table_name","deleted_count"]', JSON_KEYS(before_json)) = 1
          )
        ) AND (
          after_json IS NULL OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS('["cutoff_at","table_name","deleted_count"]', JSON_KEYS(after_json)) = 1
          )
        )
    END
  );
