-- Up Migration

CREATE TABLE polls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  option_count SMALLINT NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT polls_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT polls_creator_class_foreign_key FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT polls_title_check CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 100
    AND title !~ '[[:cntrl:]]'
  ),
  CONSTRAINT polls_description_check CHECK (
    description IS NULL
    OR (
      description = btrim(description)
      AND char_length(description) BETWEEN 1 AND 500
    )
  ),
  CONSTRAINT polls_option_count_check CHECK (option_count BETWEEN 2 AND 10),
  CONSTRAINT polls_closes_at_check CHECK (
    closes_at >= created_at + interval '5 minutes'
    AND closes_at <= created_at + interval '30 days'
  ),
  CONSTRAINT polls_row_version_check CHECK (row_version >= 1)
);

CREATE TABLE poll_options (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id BIGINT NOT NULL REFERENCES polls (id) ON DELETE RESTRICT,
  position SMALLINT NOT NULL,
  label TEXT NOT NULL,
  label_normalized TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(btrim(label), '[[:space:]]+', ' ', 'g'))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT poll_options_id_poll_unique UNIQUE (id, poll_id),
  CONSTRAINT poll_options_poll_position_unique UNIQUE (poll_id, position),
  CONSTRAINT poll_options_poll_label_unique UNIQUE (poll_id, label_normalized),
  CONSTRAINT poll_options_position_check CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT poll_options_label_check CHECK (
    label = btrim(label)
    AND char_length(label) BETWEEN 1 AND 80
    AND label !~ '[[:cntrl:]]'
  )
);

CREATE TABLE poll_votes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  option_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT poll_votes_poll_member_unique UNIQUE (poll_id, member_id),
  CONSTRAINT poll_votes_poll_class_foreign_key FOREIGN KEY (poll_id, class_id)
    REFERENCES polls (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT poll_votes_option_poll_foreign_key FOREIGN KEY (option_id, poll_id)
    REFERENCES poll_options (id, poll_id) ON DELETE RESTRICT,
  CONSTRAINT poll_votes_member_class_foreign_key FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

CREATE INDEX polls_class_status_index
  ON polls (class_id, closes_at DESC, created_at DESC, id DESC);

CREATE INDEX poll_options_poll_position_index
  ON poll_options (poll_id, position, id);

CREATE INDEX poll_votes_poll_option_index
  ON poll_votes (poll_id, option_id, id);

CREATE INDEX poll_votes_member_index
  ON poll_votes (member_id, poll_id);

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
    'poll.created', 'poll.deleted'
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

REVOKE ALL PRIVILEGES ON polls, poll_options, poll_votes FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  polls_id_seq, poll_options_id_seq, poll_votes_id_seq
FROM PUBLIC;

GRANT SELECT, INSERT, DELETE ON polls, poll_options, poll_votes TO classhub_app;
GRANT USAGE ON SEQUENCE
  polls_id_seq, poll_options_id_seq, poll_votes_id_seq
TO classhub_app;

-- Down Migration

DO $class_polls_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM poll_votes)
    OR EXISTS (SELECT 1 FROM poll_options)
    OR EXISTS (SELECT 1 FROM polls) THEN
    RAISE EXCEPTION
      'class polls rollback requires polls, poll_options, and poll_votes to be empty';
  END IF;

  IF EXISTS (SELECT 1 FROM audit_logs WHERE action LIKE 'poll.%') THEN
    RAISE EXCEPTION
      'class polls rollback requires poll audit rows to be empty';
  END IF;
END
$class_polls_rollback_guard$;

REVOKE ALL PRIVILEGES ON polls, poll_options, poll_votes FROM classhub_app;
REVOKE ALL PRIVILEGES ON
  polls_id_seq, poll_options_id_seq, poll_votes_id_seq
FROM classhub_app;

DROP TABLE poll_votes;
DROP TABLE poll_options;
DROP TABLE polls;

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
    'attendance_notification.canceled', 'attendance_notification.acknowledged'
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
