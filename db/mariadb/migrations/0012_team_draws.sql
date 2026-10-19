-- T-HUB-64 MariaDB baseline phase 0012 (development only).
-- PostgreSQL sources: 1783700018000_team-draws.sql Up plus the final action
-- catalog from 1783700019000/1783700020000 adjustment-audit Up migrations.
-- Isolated synthetic QA only. Runtime privileges and validation triggers are separate.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE team_draws (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  group_count SMALLINT NOT NULL,
  initial_assigned_count SMALLINT NOT NULL,
  excluded_student_count SMALLINT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
  published_at DATETIME(6),
  superseded_at DATETIME(6),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  published_class_id BIGINT
    GENERATED ALWAYS AS (
      CASE WHEN BINARY status = BINARY 'published' THEN class_id ELSE NULL END
    ) STORED,
  PRIMARY KEY (id),
  CONSTRAINT team_draws_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT team_draws_one_published_per_class UNIQUE (published_class_id),
  CONSTRAINT team_draws_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT team_draws_creator_class_foreign_key
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draws_title_check CHECK (
    BINARY title = BINARY TRIM(title)
    AND CHAR_LENGTH(title) BETWEEN 1 AND 80
    AND title NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT team_draws_counts_check CHECK (
    group_count BETWEEN 2 AND 10
    AND initial_assigned_count BETWEEN 2 AND 60
    AND initial_assigned_count >= group_count
    AND excluded_student_count BETWEEN 0 AND 60
  ),
  CONSTRAINT team_draws_status_check CHECK (
    (
      BINARY status = BINARY 'draft'
      AND published_at IS NULL
      AND superseded_at IS NULL
    )
    OR
    (
      BINARY status = BINARY 'published'
      AND published_at IS NOT NULL
      AND superseded_at IS NULL
    )
    OR
    (
      BINARY status = BINARY 'superseded'
      AND published_at IS NOT NULL
      AND superseded_at IS NOT NULL
      AND superseded_at >= published_at
    )
  ),
  CONSTRAINT team_draws_row_version_check CHECK (row_version >= 1),
  INDEX team_draws_class_history_index (class_id, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE team_draw_groups (
  id BIGINT NOT NULL AUTO_INCREMENT,
  team_draw_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  group_index SMALLINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT team_draw_groups_id_draw_class_unique UNIQUE (id, team_draw_id, class_id),
  CONSTRAINT team_draw_groups_draw_index_unique UNIQUE (team_draw_id, group_index),
  CONSTRAINT team_draw_groups_draw_class_foreign_key
    FOREIGN KEY (team_draw_id, class_id)
    REFERENCES team_draws (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draw_groups_index_check CHECK (group_index BETWEEN 1 AND 10),
  INDEX team_draw_groups_draw_index (team_draw_id, group_index, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE team_draw_assignments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  team_draw_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  team_group_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  student_number_snapshot INT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT team_draw_assignments_draw_member_unique UNIQUE (team_draw_id, member_id),
  CONSTRAINT team_draw_assignments_draw_class_foreign_key
    FOREIGN KEY (team_draw_id, class_id)
    REFERENCES team_draws (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draw_assignments_group_draw_class_foreign_key
    FOREIGN KEY (team_group_id, team_draw_id, class_id)
    REFERENCES team_draw_groups (id, team_draw_id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draw_assignments_member_class_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draw_assignments_display_name_check CHECK (
    BINARY display_name_snapshot = BINARY TRIM(display_name_snapshot)
    AND CHAR_LENGTH(display_name_snapshot) BETWEEN 1 AND 20
    AND display_name_snapshot NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT team_draw_assignments_student_number_check CHECK (
    student_number_snapshot IS NULL OR student_number_snapshot BETWEEN 1 AND 99
  ),
  INDEX team_draw_assignments_member_index (member_id, team_draw_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Keep existing reminder shape and attendance privacy checks.
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
      BINARY 'attendance_notification.canceled', BINARY 'attendance_notification.acknowledged',
      BINARY 'poll.created', BINARY 'poll.deleted',
      BINARY 'seat_draw.created', BINARY 'seat_draw.adjusted', BINARY 'seat_draw.published',
      BINARY 'seat_draw.superseded', BINARY 'seat_draw.deleted',
      BINARY 'team_draw.created', BINARY 'team_draw.adjusted', BINARY 'team_draw.published',
      BINARY 'team_draw.superseded', BINARY 'team_draw.deleted'
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
      WHEN action LIKE 'poll.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]',
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
              '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]',
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
              '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'seat_draw.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]',
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
              '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]',
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
              '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'team_draw.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]',
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
              '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]',
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
              '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]',
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
