-- T-HUB-64 MariaDB baseline phase 0006 (development only).
-- Provisional target: MariaDB 11.4 LTS. Isolated synthetic QA only.
-- PostgreSQL source: 1783700008000_in-app-reminders.sql (Up only).
-- The locked resolution trigger and all runtime privileges are separate.
-- Requires normal SQL string escaping (NO_BACKSLASH_ESCAPES absent) for PCRE end anchors.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE in_app_reminder_batches (
  id UUID NOT NULL,
  class_id BIGINT NOT NULL,
  notice_id BIGINT,
  supply_id BIGINT,
  content_revision BIGINT NOT NULL,
  created_by_member_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT in_app_reminder_batches_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT in_app_reminder_batches_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE,
  CONSTRAINT in_app_reminder_batches_notice_fk
    FOREIGN KEY (notice_id, class_id) REFERENCES notices (id, class_id) ON DELETE CASCADE,
  CONSTRAINT in_app_reminder_batches_supply_fk
    FOREIGN KEY (supply_id, class_id) REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  CONSTRAINT in_app_reminder_batches_created_by_member_fk
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT in_app_reminder_batches_resource_xor_check CHECK (
    (notice_id IS NOT NULL AND supply_id IS NULL)
    OR (notice_id IS NULL AND supply_id IS NOT NULL)
  ),
  CONSTRAINT in_app_reminder_batches_revision_check CHECK (content_revision >= 1),
  INDEX in_app_reminder_batches_notice_revision_index (
    class_id, notice_id, content_revision, created_at DESC, id DESC
  ),
  INDEX in_app_reminder_batches_supply_revision_index (
    class_id, supply_id, content_revision, created_at DESC, id DESC
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE in_app_reminder_recipients (
  batch_id UUID NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  resolved_at DATETIME(6),
  PRIMARY KEY (batch_id, member_id),
  CONSTRAINT in_app_reminder_recipients_batch_fk
    FOREIGN KEY (batch_id, class_id)
    REFERENCES in_app_reminder_batches (id, class_id) ON DELETE CASCADE,
  CONSTRAINT in_app_reminder_recipients_member_fk
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT in_app_reminder_recipients_resolved_time_check CHECK (
    resolved_at IS NULL OR resolved_at >= created_at
  ),
  INDEX in_app_reminder_recipients_home_unresolved_index (
    class_id, member_id, resolved_at, created_at DESC, batch_id
  ),
  INDEX in_app_reminder_recipients_member_batch_unresolved_index (
    member_id, resolved_at, batch_id
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- The phase-0005 attendance reason guard remains unchanged.
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
      BINARY 'notice.updated', BINARY 'notice.deleted', BINARY 'notice.reminder_created',
      BINARY 'supply.created',
      BINARY 'supply.updated', BINARY 'supply.deleted', BINARY 'supply.reminder_created',
      BINARY 'schedule.created',
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
      WHEN action IN ('notice.reminder_created', 'supply.reminder_created') THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '[]',
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
              '[]',
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
              '["reminder_batch_id","content_revision","current_unresolved_count","created_count","cooldown_suppressed_count"]',
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
  ADD CONSTRAINT audit_logs_reminder_created_shape_check CHECK (
    action NOT IN ('notice.reminder_created', 'supply.reminder_created')
    OR (
      (
        (action = 'notice.reminder_created' AND BINARY target_type = BINARY 'notice')
        OR
        (action = 'supply.reminder_created' AND BINARY target_type = BINARY 'supply')
      )
      AND BINARY target_id REGEXP '^[1-9][0-9]*\\z'
      AND target_snapshot IS NULL
      AND before_json IS NULL
      AND reason IS NULL
      -- Preserve source CHECK three-valued logic: SQL NULL after_json is UNKNOWN.
      AND JSON_TYPE(after_json) = 'OBJECT'
      AND JSON_CONTAINS_PATH(
        after_json, 'all', '$.reminder_batch_id', '$.content_revision',
        '$.current_unresolved_count', '$.created_count', '$.cooldown_suppressed_count'
      ) = 1
      AND JSON_TYPE(JSON_EXTRACT(after_json, '$.reminder_batch_id')) = 'STRING'
      AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.reminder_batch_id'))) REGEXP
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z'
      AND JSON_TYPE(JSON_EXTRACT(after_json, '$.content_revision')) = 'STRING'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.content_revision'))
        REGEXP '^[1-9][0-9]*\\z'
      AND JSON_TYPE(JSON_EXTRACT(after_json, '$.current_unresolved_count'))
        IN ('INTEGER', 'DOUBLE')
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.current_unresolved_count'))
        REGEXP '^(0|[1-9][0-9]*)\\z'
      AND JSON_TYPE(JSON_EXTRACT(after_json, '$.created_count')) IN ('INTEGER', 'DOUBLE')
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.created_count'))
        REGEXP '^(0|[1-9][0-9]*)\\z'
      AND JSON_TYPE(JSON_EXTRACT(after_json, '$.cooldown_suppressed_count'))
        IN ('INTEGER', 'DOUBLE')
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.cooldown_suppressed_count'))
        REGEXP '^(0|[1-9][0-9]*)\\z'
    )
  );
