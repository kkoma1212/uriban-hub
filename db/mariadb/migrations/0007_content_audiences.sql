-- T-HUB-64 MariaDB baseline phase 0007 (development only).
-- Provisional target: MariaDB 11.4 LTS. Isolated synthetic QA only.
-- PostgreSQL source: 1783700009000_content-audiences.sql (Up only).
-- The two locked audience triggers and their grants are separate.
-- The supply category already folded into phase 0003 stays unchanged.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE notices
  ADD COLUMN audience_mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin
    NOT NULL DEFAULT 'legacy_class',
  ADD COLUMN category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin
    NOT NULL DEFAULT 'general',
  ADD CONSTRAINT notices_audience_mode_check CHECK (
    BINARY audience_mode IN (BINARY 'legacy_class', BINARY 'all_snapshot', BINARY 'selected_snapshot')
  ),
  ADD CONSTRAINT notices_category_check CHECK (
    BINARY category IN (BINARY 'general', BINARY 'performance')
  );

ALTER TABLE supplies
  ADD COLUMN audience_mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin
    NOT NULL DEFAULT 'legacy_class',
  ADD CONSTRAINT supplies_audience_mode_check CHECK (
    BINARY audience_mode IN (BINARY 'legacy_class', BINARY 'all_snapshot', BINARY 'selected_snapshot')
  );

CREATE TABLE notice_recipients (
  notice_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (notice_id, member_id),
  CONSTRAINT notice_recipients_notice_fk
    FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE,
  CONSTRAINT notice_recipients_member_fk
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  INDEX notice_recipients_member_content_index (class_id, member_id, notice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE supply_recipients (
  supply_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (supply_id, member_id),
  CONSTRAINT supply_recipients_supply_fk
    FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  CONSTRAINT supply_recipients_member_fk
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  INDEX supply_recipients_member_content_index (class_id, member_id, supply_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX notices_category_updates_index
  ON notices (class_id, deleted_at, category, published_at DESC, id DESC);
CREATE INDEX supplies_updates_index
  ON supplies (class_id, deleted_at, created_at DESC, id DESC);

-- Keep the phase-0006 action/shape and phase-0005 attendance-reason checks.
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_json_allowlist_check,
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
              '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]',
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
              '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]',
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
              '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]',
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
              '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]',
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
              '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]',
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
              '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]',
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
  );

