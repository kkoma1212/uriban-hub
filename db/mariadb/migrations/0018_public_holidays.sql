-- T-HUB-64 phase 0018. Isolated synthetic development only; runtime ACLs remain separate.
-- PostgreSQL source: 1783700037000_public-holidays.sql (Up only).
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE public_holidays (
  holiday_date DATE NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_loaded_on DATE NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT public_holidays_name_check CHECK (
    BINARY name = BINARY TRIM(name)
    AND CHAR_LENGTH(name) BETWEEN 1 AND 60
    AND name NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT public_holidays_source_check CHECK (BINARY source = BINARY 'kasi'),
  CONSTRAINT public_holidays_date_range_check CHECK (
    holiday_date BETWEEN DATE '2020-01-01' AND DATE '2100-12-31'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
  COMMENT='전국 공통 법정공휴일. 출처는 한국천문연구원 특일 정보(공공데이터포털).';

-- Preserve all 21 actions and every JSON branch from source 0037.
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'operator.bootstrapped',
      BINARY 'operator.created',
      BINARY 'operator.revoked',
      BINARY 'operator.token_rotated',
      BINARY 'operator.credential_recovered',
      BINARY 'teacher.created',
      BINARY 'teacher.password_reset',
      BINARY 'teacher.transferred',
      BINARY 'teacher.revoked',
      BINARY 'class.suspended',
      BINARY 'class.archived',
      BINARY 'class.reactivated',
      BINARY 'user.deactivated',
      BINARY 'user.reactivated',
      BINARY 'school.imported',
      BINARY 'meal.imported',
      BINARY 'school_schedule.imported',
      BINARY 'holiday.imported',
      BINARY 'retention.executed',
      BINARY 'reminder.executed',
      BINARY 'job.failed'
    )
  ),
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["operator_id","status"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["operator_id","status"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action LIKE 'teacher.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["teacher_user_id","teacher_profile_status","class_id","reason"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["teacher_user_id","teacher_profile_status","class_id","reason"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action LIKE 'class.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["class_id","status","teacher_user_id","reason"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["class_id","status","teacher_user_id","reason"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action LIKE 'user.%' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["user_id","is_active","reason"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["user_id","is_active","reason"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action IN ('school.imported', 'meal.imported', 'school_schedule.imported', 'holiday.imported') THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action = 'reminder.executed' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["eligible_count","sent_count","failed_count","window_ends_at"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["eligible_count","sent_count","failed_count","window_ends_at"]', JSON_KEYS(after_json)) = 1
        ))
      WHEN action = 'job.failed' THEN
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["job_name","error_name"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["job_name","error_name"]', JSON_KEYS(after_json)) = 1
        ))
      ELSE
        (before_json IS NULL OR (
          JSON_TYPE(before_json) = 'OBJECT'
          AND JSON_CONTAINS('["cutoff_at","table_name","deleted_count"]', JSON_KEYS(before_json)) = 1
        )) AND
        (after_json IS NULL OR (
          JSON_TYPE(after_json) = 'OBJECT'
          AND JSON_CONTAINS('["cutoff_at","table_name","deleted_count"]', JSON_KEYS(after_json)) = 1
        ))
    END
  );
