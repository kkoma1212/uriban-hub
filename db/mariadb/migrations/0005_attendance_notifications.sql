-- T-HUB-64 MariaDB baseline phase 0005 (development only).
-- Provisional target: MariaDB 11.4 LTS. Apply only to an isolated synthetic QA database.
-- PostgreSQL source: 1783700006000_attendance-notifications.sql (Up only).
-- Requires TIME_ROUND_FRACTIONAL in the session sql_mode for PostgreSQL TIME(0) parity.
-- Runtime grants and later feature-owned audit contracts remain separate.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE attendance_notifications (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  notification_date DATE NOT NULL,
  notification_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_time TIME(0),
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  row_version BIGINT NOT NULL DEFAULT 1,
  submitted_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  acknowledged_by_member_id BIGINT,
  acknowledged_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT attendance_notifications_class_member_date_unique UNIQUE (
    class_id, member_id, notification_date
  ),
  CONSTRAINT attendance_notifications_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT attendance_notifications_member_fk
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_notifications_acknowledged_by_member_fk
    FOREIGN KEY (acknowledged_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_notifications_type_check CHECK (
    BINARY notification_type IN (BINARY 'late', BINARY 'absent', BINARY 'early')
  ),
  CONSTRAINT attendance_notifications_expected_time_check CHECK (
    (BINARY notification_type IN (BINARY 'late', BINARY 'early') AND expected_time IS NOT NULL)
    OR (BINARY notification_type = BINARY 'absent' AND expected_time IS NULL)
  ),
  -- MariaDB TIME also admits durations; the source TIME WITHOUT TIME ZONE does not.
  CONSTRAINT attendance_notifications_expected_time_range_check CHECK (
    expected_time IS NULL
    OR expected_time BETWEEN CAST('00:00:00' AS TIME) AND CAST('24:00:00' AS TIME)
  ),
  CONSTRAINT attendance_notifications_expected_time_seconds_check CHECK (
    expected_time IS NULL OR SECOND(expected_time) = 0
  ),
  CONSTRAINT attendance_notifications_status_check CHECK (
    BINARY status IN (BINARY 'pending', BINARY 'acknowledged', BINARY 'canceled')
  ),
  CONSTRAINT attendance_notifications_acknowledgement_check CHECK (
    (
      BINARY status = BINARY 'acknowledged'
      AND acknowledged_by_member_id IS NOT NULL
      AND acknowledged_at IS NOT NULL
    )
    OR
    (
      BINARY status IN (BINARY 'pending', BINARY 'canceled')
      AND acknowledged_by_member_id IS NULL
      AND acknowledged_at IS NULL
    )
  ),
  CONSTRAINT attendance_notifications_row_version_check CHECK (row_version >= 1),
  INDEX attendance_notifications_class_date_status_index (
    class_id, notification_date, status, id
  ),
  INDEX attendance_notifications_member_date_index (member_id, notification_date DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE notices
  DROP INDEX notices_importance_index,
  ADD INDEX notices_importance_index (
    class_id, deleted_at, is_important DESC, published_at DESC, id DESC
  );

-- Replace only the two phase-0004 checks whose source contract changes here.
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  DROP CONSTRAINT audit_logs_json_allowlist_check,
  ADD CONSTRAINT audit_logs_action_check CHECK (
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
      BINARY 'schedule.updated', BINARY 'schedule.deleted',
      BINARY 'attendance_notification.created', BINARY 'attendance_notification.updated',
      BINARY 'attendance_notification.canceled', BINARY 'attendance_notification.acknowledged'
    )
  ),
  ADD CONSTRAINT audit_logs_json_allowlist_check CHECK (
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
      WHEN action LIKE 'attendance_notification.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["attendance_notification_id","notification_type","notification_date","status"]',
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
              '["attendance_notification_id","notification_type","notification_date","status"]',
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
              '["attendance_notification_id","notification_type","notification_date","status"]',
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
  ADD CONSTRAINT audit_logs_attendance_reason_check CHECK (
    action NOT LIKE 'attendance_notification.%' OR reason IS NULL
  );
