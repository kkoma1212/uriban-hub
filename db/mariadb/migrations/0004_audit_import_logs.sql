-- T-HUB-64 MariaDB baseline phase 0004 (development only).
-- Provisional target: MariaDB 11.4 LTS. Apply only to an isolated synthetic QA database.
-- PostgreSQL source: 1783700003000_audit-import-logs.sql.
-- Later feature-owned audit action/JSON changes remain in their owning phases.
-- This file creates tables only. The locked-definer trigger and all runtime ACLs are separate.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE operator_audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  actor_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operator_id BIGINT,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_type VARCHAR(128) NOT NULL,
  target_id VARCHAR(512) NOT NULL,
  before_json JSON,
  after_json JSON,
  checksum VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  run_id UUID NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT operator_audit_logs_run_action_target_unique UNIQUE (
    run_id, action, target_type, target_id
  ),
  CONSTRAINT operator_audit_logs_operator_fk
    FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE RESTRICT,
  CONSTRAINT operator_audit_logs_actor_type_check CHECK (
    BINARY actor_type IN (BINARY 'operator', BINARY 'system')
  ),
  CONSTRAINT operator_audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'operator.bootstrapped', BINARY 'operator.created',
      BINARY 'operator.revoked', BINARY 'operator.token_rotated',
      BINARY 'operator.credential_recovered', BINARY 'teacher.created',
      BINARY 'teacher.transferred', BINARY 'teacher.revoked',
      BINARY 'class.suspended', BINARY 'class.archived',
      BINARY 'class.reactivated', BINARY 'user.deactivated',
      BINARY 'user.reactivated', BINARY 'school.imported',
      BINARY 'meal.imported', BINARY 'retention.executed'
    )
  ),
  CONSTRAINT operator_audit_logs_actor_check CHECK (
    (BINARY actor_type = BINARY 'operator' AND operator_id IS NOT NULL)
    OR
    (
      BINARY actor_type = BINARY 'system'
      AND operator_id IS NULL
      AND BINARY action IN (
        BINARY 'operator.bootstrapped',
        BINARY 'operator.credential_recovered',
        BINARY 'retention.executed'
      )
    )
  ),
  CONSTRAINT operator_audit_logs_target_check CHECK (
    CHAR_LENGTH(TRIM(target_type)) > 0 AND CHAR_LENGTH(TRIM(target_id)) > 0
  ),
  CONSTRAINT operator_audit_logs_checksum_check CHECK (
    checksum IS NULL
    OR (OCTET_LENGTH(checksum) = 64 AND BINARY checksum REGEXP '^[0-9a-f]{64}$')
  ),
  CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["operator_id","status"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["operator_id","status"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'teacher.%' THEN
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["teacher_user_id","teacher_profile_status","class_id","reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["teacher_user_id","teacher_profile_status","class_id","reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'class.%' THEN
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","status","teacher_user_id","reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","status","teacher_user_id","reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'user.%' THEN
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["user_id","is_active","reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["user_id","is_active","reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action IN ('school.imported', 'meal.imported') THEN
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["file_name","checksum","result","inserted_count","updated_count","deleted_count","skipped_count","failed_count"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      ELSE
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["cutoff_at","table_name","deleted_count"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["cutoff_at","table_name","deleted_count"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
    END
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE school_import_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_id UUID NOT NULL,
  operator_id BIGINT NOT NULL,
  file_name TEXT NOT NULL,
  checksum VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  inserted_count INT NOT NULL,
  updated_count INT NOT NULL,
  skipped_count INT NOT NULL,
  failed_count INT NOT NULL,
  result VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  error_json JSON,
  started_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT school_import_logs_run_id_unique UNIQUE (run_id),
  CONSTRAINT school_import_logs_operator_fk
    FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE RESTRICT,
  CONSTRAINT school_import_logs_checksum_check CHECK (
    OCTET_LENGTH(checksum) = 64 AND BINARY checksum REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT school_import_logs_counts_check CHECK (
    inserted_count >= 0
    AND updated_count >= 0
    AND skipped_count >= 0
    AND failed_count >= 0
  ),
  CONSTRAINT school_import_logs_result_check CHECK (
    BINARY result IN (BINARY 'success', BINARY 'failed')
  ),
  CONSTRAINT school_import_logs_time_check CHECK (started_at <= completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE meal_import_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_id UUID NOT NULL,
  operator_id BIGINT NOT NULL,
  file_name TEXT NOT NULL,
  checksum VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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
  CONSTRAINT meal_import_logs_run_id_unique UNIQUE (run_id),
  CONSTRAINT meal_import_logs_operator_fk
    FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE RESTRICT,
  CONSTRAINT meal_import_logs_checksum_check CHECK (
    OCTET_LENGTH(checksum) = 64 AND BINARY checksum REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT meal_import_logs_counts_check CHECK (
    inserted_count >= 0
    AND updated_count >= 0
    AND deleted_count >= 0
    AND skipped_count >= 0
    AND failed_count >= 0
  ),
  CONSTRAINT meal_import_logs_result_check CHECK (
    BINARY result IN (BINARY 'success', BINARY 'failed')
  ),
  CONSTRAINT meal_import_logs_time_check CHECK (started_at <= completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  actor_user_id BIGINT,
  actor_member_id BIGINT,
  actor_display_name_snapshot TEXT NOT NULL,
  actor_role_snapshot VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_snapshot JSON,
  before_json JSON,
  after_json JSON,
  reason TEXT,
  request_id UUID NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT audit_logs_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT audit_logs_actor_user_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT audit_logs_actor_member_fk
    FOREIGN KEY (actor_member_id) REFERENCES class_members (id) ON DELETE SET NULL,
  CONSTRAINT audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'class.created', BINARY 'class.updated', BINARY 'class.suspended',
      BINARY 'class.reactivated', BINARY 'class.archived',
      BINARY 'invite_code.created', BINARY 'invite_code.revoked',
      BINARY 'member.requested', BINARY 'member.request_canceled',
      BINARY 'member.approved', BINARY 'member.rejected', BINARY 'member.left',
      BINARY 'member.removed', BINARY 'member.rejoin_allowed',
      BINARY 'member.profile_updated', BINARY 'member.account_deleted',
      BINARY 'class.teacher_transferred', BINARY 'notice.created',
      BINARY 'notice.updated', BINARY 'notice.deleted', BINARY 'supply.created',
      BINARY 'supply.updated', BINARY 'supply.deleted', BINARY 'schedule.created',
      BINARY 'schedule.updated', BINARY 'schedule.deleted'
    )
  ),
  CONSTRAINT audit_logs_actor_role_check CHECK (
    BINARY actor_role_snapshot IN (BINARY 'teacher', BINARY 'student', BINARY 'operator')
  ),
  CONSTRAINT audit_logs_target_check CHECK (
    CHAR_LENGTH(TRIM(target_type)) > 0 AND CHAR_LENGTH(TRIM(target_id)) > 0
  ),
  CONSTRAINT audit_logs_reason_check CHECK (reason IS NULL OR CHAR_LENGTH(reason) <= 300),
  CONSTRAINT audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'class.%' AND action <> 'class.teacher_transferred' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'invite_code.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'member.%' OR action = 'class.teacher_transferred' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["member_id","role","status","display_name_snapshot","reason"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["member_id","role","status","display_name_snapshot","reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["member_id","role","status","display_name_snapshot","reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'notice.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["notice_id","title","is_important","content_revision","published_at","deleted_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["notice_id","title","is_important","content_revision","published_at","deleted_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["notice_id","title","is_important","content_revision","published_at","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'supply.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["supply_id","title","needed_on","content_revision","deleted_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["supply_id","title","needed_on","content_revision","deleted_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["supply_id","title","needed_on","content_revision","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      ELSE
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
    END
  ),
  INDEX audit_logs_class_created_index (class_id, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE security_audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_id UUID NOT NULL,
  actor_user_id BIGINT,
  actor_email_hmac TEXT,
  hmac_key_version TEXT,
  actor_ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin,
  actor_class_id BIGINT,
  target_class_id BIGINT,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource TEXT,
  sanitized_path TEXT NOT NULL,
  method TEXT NOT NULL,
  deny_reason TEXT,
  failure_code TEXT,
  request_id UUID NOT NULL,
  user_agent TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT security_audit_logs_event_id_unique UNIQUE (event_id),
  CONSTRAINT security_audit_logs_actor_user_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT security_audit_logs_actor_class_fk
    FOREIGN KEY (actor_class_id) REFERENCES classes (id) ON DELETE SET NULL,
  CONSTRAINT security_audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'auth.login_failed', BINARY 'auth.password_reset_requested',
      BINARY 'auth.password_reset_completed', BINARY 'auth.logout',
      BINARY 'auth.csrf_failed', BINARY 'authz.denied', BINARY 'rate_limited',
      BINARY 'email.delivery_failed', BINARY 'account.deleted'
    )
  ),
  CONSTRAINT security_audit_logs_hmac_check CHECK (
    (actor_email_hmac IS NULL AND hmac_key_version IS NULL)
    OR (actor_email_hmac IS NOT NULL AND hmac_key_version IS NOT NULL)
  ),
  CONSTRAINT security_audit_logs_actor_ip_check CHECK (
    actor_ip IS NULL
    OR (
      INET6_ATON(actor_ip) IS NOT NULL
      AND BINARY actor_ip = BINARY INET6_NTOA(INET6_ATON(actor_ip))
    )
  ),
  INDEX security_audit_logs_created_index (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
