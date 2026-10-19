-- Up Migration

CREATE TABLE team_draws (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  group_count SMALLINT NOT NULL,
  initial_assigned_count SMALLINT NOT NULL,
  excluded_student_count SMALLINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT team_draws_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT team_draws_creator_class_foreign_key
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draws_title_check CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 80
    AND title !~ '[[:cntrl:]]'
  ),
  CONSTRAINT team_draws_counts_check CHECK (
    group_count BETWEEN 2 AND 10
    AND initial_assigned_count BETWEEN 2 AND 60
    AND initial_assigned_count >= group_count
    AND excluded_student_count BETWEEN 0 AND 60
  ),
  CONSTRAINT team_draws_status_check CHECK (
    (
      status = 'draft'
      AND published_at IS NULL
      AND superseded_at IS NULL
    )
    OR
    (
      status = 'published'
      AND published_at IS NOT NULL
      AND superseded_at IS NULL
    )
    OR
    (
      status = 'superseded'
      AND published_at IS NOT NULL
      AND superseded_at IS NOT NULL
      AND superseded_at >= published_at
    )
  ),
  CONSTRAINT team_draws_row_version_check CHECK (row_version >= 1)
);

CREATE TABLE team_draw_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_draw_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  group_index SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT team_draw_groups_id_draw_class_unique
    UNIQUE (id, team_draw_id, class_id),
  CONSTRAINT team_draw_groups_draw_index_unique
    UNIQUE (team_draw_id, group_index),
  CONSTRAINT team_draw_groups_draw_class_foreign_key
    FOREIGN KEY (team_draw_id, class_id)
    REFERENCES team_draws (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT team_draw_groups_index_check CHECK (group_index BETWEEN 1 AND 10)
);

CREATE TABLE team_draw_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_draw_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  team_group_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  student_number_snapshot INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT team_draw_assignments_draw_member_unique
    UNIQUE (team_draw_id, member_id),
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
    display_name_snapshot = btrim(display_name_snapshot)
    AND char_length(display_name_snapshot) BETWEEN 1 AND 20
    AND display_name_snapshot !~ '[[:cntrl:]]'
  ),
  CONSTRAINT team_draw_assignments_student_number_check CHECK (
    student_number_snapshot IS NULL
    OR student_number_snapshot BETWEEN 1 AND 99
  )
);

CREATE UNIQUE INDEX team_draws_one_published_per_class
  ON team_draws (class_id)
  WHERE status = 'published';

CREATE INDEX team_draws_class_history_index
  ON team_draws (class_id, created_at DESC, id DESC);

CREATE INDEX team_draw_groups_draw_index
  ON team_draw_groups (team_draw_id, group_index, id);

CREATE INDEX team_draw_assignments_member_index
  ON team_draw_assignments (member_id, team_draw_id);

CREATE FUNCTION validate_team_draw_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_group_count SMALLINT;
BEGIN
  SELECT group_count
  INTO target_group_count
  FROM team_draws
  WHERE id = NEW.team_draw_id AND class_id = NEW.class_id;

  IF target_group_count IS NULL THEN
    RAISE EXCEPTION 'team draw does not belong to group class'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.group_index > target_group_count THEN
    RAISE EXCEPTION 'team group index exceeds draw group count'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER validate_team_draw_group_trigger
BEFORE INSERT OR UPDATE ON team_draw_groups
FOR EACH ROW EXECUTE FUNCTION validate_team_draw_group();

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  DROP CONSTRAINT audit_logs_json_allowlist_check;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted',
    'notice.reminder_created',
    'supply.created', 'supply.updated', 'supply.deleted',
    'supply.reminder_created',
    'schedule.created', 'schedule.updated', 'schedule.deleted',
    'attendance_notification.created', 'attendance_notification.updated',
    'attendance_notification.canceled', 'attendance_notification.acknowledged',
    'poll.created', 'poll.deleted',
    'seat_draw.created', 'seat_draw.published', 'seat_draw.superseded',
    'seat_draw.deleted',
    'team_draw.created', 'team_draw.published', 'team_draw.superseded',
    'team_draw.deleted'
  )),
  ADD CONSTRAINT audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'class.%' AND action <> 'class.teacher_transferred' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'class_id', 'name', 'academic_year', 'grade', 'expected_student_count',
            'status', 'suspended_reason', 'archived_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'class_id', 'name', 'academic_year', 'grade', 'expected_student_count',
            'status', 'suspended_reason', 'archived_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'class_id', 'name', 'academic_year', 'grade', 'expected_student_count',
            'status', 'suspended_reason', 'archived_at'
          ]
        )
      WHEN action LIKE 'invite_code.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'invite_code_id', 'class_id', 'expires_at', 'revoked_at', 'revoke_reason'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'invite_code_id', 'class_id', 'expires_at', 'revoked_at', 'revoke_reason'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'invite_code_id', 'class_id', 'expires_at', 'revoked_at', 'revoke_reason'
          ]
        )
      WHEN action LIKE 'member.%' OR action = 'class.teacher_transferred' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY['member_id', 'role', 'status', 'display_name_snapshot', 'reason']
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY['member_id', 'role', 'status', 'display_name_snapshot', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['member_id', 'role', 'status', 'display_name_snapshot', 'reason']
        )
      WHEN action IN ('notice.reminder_created', 'supply.reminder_created') THEN
        jsonb_has_only_keys(target_snapshot, ARRAY[]::TEXT[])
        AND jsonb_has_only_keys(before_json, ARRAY[]::TEXT[])
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'reminder_batch_id', 'content_revision', 'current_unresolved_count',
            'created_count', 'cooldown_suppressed_count'
          ]
        )
      WHEN action LIKE 'notice.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at', 'category', 'audience_mode',
            'recipient_count'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at', 'category', 'audience_mode',
            'recipient_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at', 'category', 'audience_mode',
            'recipient_count'
          ]
        )
      WHEN action LIKE 'supply.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at',
            'audience_mode', 'recipient_count'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at',
            'audience_mode', 'recipient_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at',
            'audience_mode', 'recipient_count'
          ]
        )
      WHEN action LIKE 'attendance_notification.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'attendance_notification_id', 'notification_type',
            'notification_date', 'status'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'attendance_notification_id', 'notification_type',
            'notification_date', 'status'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'attendance_notification_id', 'notification_type',
            'notification_date', 'status'
          ]
        )
      WHEN action LIKE 'poll.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'poll_id', 'title', 'closes_at', 'option_count', 'vote_count', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'poll_id', 'title', 'closes_at', 'option_count', 'vote_count', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'poll_id', 'title', 'closes_at', 'option_count', 'vote_count', 'deleted_at'
          ]
        )
      WHEN action LIKE 'seat_draw.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'seat_draw_id', 'title', 'row_count', 'column_count',
            'usable_seat_count', 'assigned_student_count',
            'excluded_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'seat_draw_id', 'title', 'row_count', 'column_count',
            'usable_seat_count', 'assigned_student_count',
            'excluded_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'seat_draw_id', 'title', 'row_count', 'column_count',
            'usable_seat_count', 'assigned_student_count',
            'excluded_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
      WHEN action LIKE 'team_draw.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'team_draw_id', 'title', 'group_count', 'assigned_student_count',
            'excluded_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'team_draw_id', 'title', 'group_count', 'assigned_student_count',
            'excluded_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'team_draw_id', 'title', 'group_count', 'assigned_student_count',
            'excluded_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
      ELSE
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'schedule_id', 'title', 'subject', 'schedule_type', 'due_date', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'schedule_id', 'title', 'subject', 'schedule_type', 'due_date', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'schedule_id', 'title', 'subject', 'schedule_type', 'due_date', 'deleted_at'
          ]
        )
    END
  );

REVOKE ALL PRIVILEGES ON
  team_draws, team_draw_groups, team_draw_assignments
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  team_draws_id_seq, team_draw_groups_id_seq, team_draw_assignments_id_seq
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON team_draws TO classhub_app;
GRANT SELECT, INSERT, DELETE ON team_draw_groups, team_draw_assignments TO classhub_app;
GRANT USAGE ON SEQUENCE
  team_draws_id_seq, team_draw_groups_id_seq, team_draw_assignments_id_seq
TO classhub_app;

-- Down Migration

DO $team_draws_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM team_draw_assignments)
    OR EXISTS (SELECT 1 FROM team_draw_groups)
    OR EXISTS (SELECT 1 FROM team_draws) THEN
    RAISE EXCEPTION
      'team draws rollback requires team_draws, team_draw_groups, and team_draw_assignments to be empty';
  END IF;

  IF EXISTS (SELECT 1 FROM audit_logs WHERE action LIKE 'team_draw.%') THEN
    RAISE EXCEPTION
      'team draws rollback requires team draw audit rows to be empty';
  END IF;
END
$team_draws_rollback_guard$;

REVOKE ALL PRIVILEGES ON
  team_draws, team_draw_groups, team_draw_assignments
FROM classhub_app;
REVOKE ALL PRIVILEGES ON
  team_draws_id_seq, team_draw_groups_id_seq, team_draw_assignments_id_seq
FROM classhub_app;

DROP TRIGGER validate_team_draw_group_trigger ON team_draw_groups;
DROP FUNCTION validate_team_draw_group();

DROP TABLE team_draw_assignments;
DROP TABLE team_draw_groups;
DROP TABLE team_draws;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted',
    'notice.reminder_created',
    'supply.created', 'supply.updated', 'supply.deleted',
    'supply.reminder_created',
    'schedule.created', 'schedule.updated', 'schedule.deleted',
    'attendance_notification.created', 'attendance_notification.updated',
    'attendance_notification.canceled', 'attendance_notification.acknowledged',
    'poll.created', 'poll.deleted',
    'seat_draw.created', 'seat_draw.published', 'seat_draw.superseded',
    'seat_draw.deleted'
  ));
