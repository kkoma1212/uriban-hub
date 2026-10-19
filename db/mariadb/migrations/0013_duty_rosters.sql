-- T-HUB-64 MariaDB phase 0013, isolated synthetic QA only.
-- Source: 1783700028000_class-duty-rosters.sql Up. Runtime activation remains blocked.
-- Composite foreign keys preserve the source boundary without new triggers or grants.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE class_duty_roles (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  required_count SMALLINT NOT NULL,
  sort_index SMALLINT NOT NULL,


  archived_at DATETIME(6),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  active_name VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin
    GENERATED ALWAYS AS (CASE WHEN archived_at IS NULL THEN name ELSE NULL END) STORED,
  CONSTRAINT class_duty_roles_active_name_unique UNIQUE (class_id, active_name),
  CONSTRAINT class_duty_roles_class_fk FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  INDEX class_duty_roles_class_order_index (class_id, sort_index, id),
  CONSTRAINT class_duty_roles_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_duty_roles_name_check CHECK (
    BINARY name = BINARY TRIM(name)
    AND CHAR_LENGTH(name) BETWEEN 1 AND 20
    AND name NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT class_duty_roles_counts_check CHECK (
    required_count BETWEEN 1 AND 60
    AND sort_index BETWEEN 1 AND 30
  ),
  CONSTRAINT class_duty_roles_row_version_check CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE duty_rosters (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  role_count SMALLINT NOT NULL,
  assigned_student_count SMALLINT NOT NULL,

  unassigned_student_count SMALLINT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
  published_at DATETIME(6),
  superseded_at DATETIME(6),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  published_class_id BIGINT
    GENERATED ALWAYS AS (CASE WHEN BINARY status = BINARY 'published' THEN class_id ELSE NULL END) STORED,
  CONSTRAINT duty_rosters_one_published_per_class UNIQUE (published_class_id),
  CONSTRAINT duty_rosters_class_fk FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  INDEX duty_rosters_class_history_index (class_id, created_at DESC, id DESC),
  CONSTRAINT duty_rosters_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT duty_rosters_creator_class_foreign_key
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT duty_rosters_title_check CHECK (
    BINARY title = BINARY TRIM(title)
    AND CHAR_LENGTH(title) BETWEEN 1 AND 80
    AND title NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT duty_rosters_counts_check CHECK (
    role_count BETWEEN 1 AND 30
    AND assigned_student_count BETWEEN 0 AND 60
    AND unassigned_student_count BETWEEN 0 AND 60
  ),
  CONSTRAINT duty_rosters_status_check CHECK (
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
  CONSTRAINT duty_rosters_row_version_check CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE duty_assignments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  duty_roster_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  duty_role_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  student_number_snapshot INTEGER,

  role_name_snapshot TEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),

  INDEX duty_assignments_member_index (member_id, duty_roster_id),
  INDEX duty_assignments_roster_role_index (duty_roster_id, duty_role_id, id),
  CONSTRAINT duty_assignments_roster_member_unique
    UNIQUE (duty_roster_id, member_id),
  CONSTRAINT duty_assignments_roster_class_foreign_key
    FOREIGN KEY (duty_roster_id, class_id)
    REFERENCES duty_rosters (id, class_id) ON DELETE RESTRICT,


  CONSTRAINT duty_assignments_role_class_foreign_key
    FOREIGN KEY (duty_role_id, class_id)
    REFERENCES class_duty_roles (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT duty_assignments_member_class_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT duty_assignments_display_name_check CHECK (
    BINARY display_name_snapshot = BINARY TRIM(display_name_snapshot)
    AND CHAR_LENGTH(display_name_snapshot) BETWEEN 1 AND 20
    AND display_name_snapshot NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT duty_assignments_role_name_check CHECK (
    BINARY role_name_snapshot = BINARY TRIM(role_name_snapshot)
    AND CHAR_LENGTH(role_name_snapshot) BETWEEN 1 AND 20
    AND role_name_snapshot NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT duty_assignments_student_number_check CHECK (
    student_number_snapshot IS NULL
    OR student_number_snapshot BETWEEN 1 AND 99
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;


-- Preserve existing reminder shape and attendance privacy checks.
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  DROP CONSTRAINT audit_logs_json_allowlist_check,
  ADD CONSTRAINT audit_logs_action_check CHECK (BINARY action IN (
    BINARY 'class.created', BINARY 'class.updated', BINARY 'class.suspended', BINARY 'class.reactivated',
    BINARY 'class.archived', BINARY 'invite_code.created', BINARY 'invite_code.revoked',
    BINARY 'member.requested', BINARY 'member.request_canceled', BINARY 'member.approved',
    BINARY 'member.rejected', BINARY 'member.left', BINARY 'member.removed', BINARY 'member.rejoin_allowed',
    BINARY 'member.profile_updated', BINARY 'member.account_deleted', BINARY 'class.teacher_transferred',
    BINARY 'notice.created', BINARY 'notice.updated', BINARY 'notice.deleted',
    BINARY 'notice.reminder_created',
    BINARY 'supply.created', BINARY 'supply.updated', BINARY 'supply.deleted',
    BINARY 'supply.reminder_created',
    BINARY 'schedule.created', BINARY 'schedule.updated', BINARY 'schedule.deleted',
    BINARY 'attendance_notification.created', BINARY 'attendance_notification.updated',
    BINARY 'attendance_notification.canceled', BINARY 'attendance_notification.acknowledged',
    BINARY 'poll.created', BINARY 'poll.deleted',
    BINARY 'seat_draw.created', BINARY 'seat_draw.adjusted', BINARY 'seat_draw.published',
    BINARY 'seat_draw.superseded', BINARY 'seat_draw.deleted',
    BINARY 'team_draw.created', BINARY 'team_draw.adjusted', BINARY 'team_draw.published',
    BINARY 'team_draw.superseded', BINARY 'team_draw.deleted',
    BINARY 'duty_role.created', BINARY 'duty_role.updated', BINARY 'duty_role.archived',
    BINARY 'duty_roster.created', BINARY 'duty_roster.published', BINARY 'duty_roster.superseded',
    BINARY 'duty_roster.deleted'
  )),
  ADD CONSTRAINT audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'class.%' AND action <> 'class.teacher_transferred' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'invite_code.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'member.%' OR action = 'class.teacher_transferred' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["member_id","role","status","display_name_snapshot","reason"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["member_id","role","status","display_name_snapshot","reason"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["member_id","role","status","display_name_snapshot","reason"]', JSON_KEYS(after_json)) = 1))
      WHEN action IN ('notice.reminder_created', 'supply.reminder_created') THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '[]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '[]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["reminder_batch_id","content_revision","current_unresolved_count","created_count","cooldown_suppressed_count"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'notice.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'supply.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'attendance_notification.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["attendance_notification_id","notification_type","notification_date","status"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["attendance_notification_id","notification_type","notification_date","status"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["attendance_notification_id","notification_type","notification_date","status"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'poll.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'seat_draw.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["seat_draw_id","title","row_count","column_count","usable_seat_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'team_draw.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["team_draw_id","title","group_count","assigned_student_count","excluded_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'duty_role.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_role_id","name","required_count","sort_index","archived_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_role_id","name","required_count","sort_index","archived_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_role_id","name","required_count","sort_index","archived_at"]', JSON_KEYS(after_json)) = 1))
      WHEN action LIKE 'duty_roster.%' THEN
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_roster_id","title","role_count","assigned_student_count","unassigned_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_roster_id","title","role_count","assigned_student_count","unassigned_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["duty_roster_id","title","role_count","assigned_student_count","unassigned_student_count","status","published_at","superseded_at","deleted_at"]', JSON_KEYS(after_json)) = 1))
      ELSE
        (target_snapshot IS NULL OR (JSON_TYPE(target_snapshot) = 'OBJECT' AND JSON_CONTAINS(
          '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]', JSON_KEYS(target_snapshot)) = 1))
        AND (before_json IS NULL OR (JSON_TYPE(before_json) = 'OBJECT' AND JSON_CONTAINS(
          '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]', JSON_KEYS(before_json)) = 1))
        AND (after_json IS NULL OR (JSON_TYPE(after_json) = 'OBJECT' AND JSON_CONTAINS(
          '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]', JSON_KEYS(after_json)) = 1))
    END
  );

