-- Up Migration

CREATE TABLE in_app_reminder_batches (
  id UUID PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  notice_id BIGINT,
  supply_id BIGINT,
  content_revision BIGINT NOT NULL,
  created_by_member_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT in_app_reminder_batches_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT in_app_reminder_batches_resource_xor_check CHECK (
    num_nonnulls(notice_id, supply_id) = 1
  ),
  CONSTRAINT in_app_reminder_batches_revision_check CHECK (content_revision >= 1),
  FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE,
  FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

CREATE INDEX in_app_reminder_batches_notice_revision_index
  ON in_app_reminder_batches (
    class_id, notice_id, content_revision, created_at DESC, id DESC
  )
  WHERE notice_id IS NOT NULL;
CREATE INDEX in_app_reminder_batches_supply_revision_index
  ON in_app_reminder_batches (
    class_id, supply_id, content_revision, created_at DESC, id DESC
  )
  WHERE supply_id IS NOT NULL;

CREATE TABLE in_app_reminder_recipients (
  batch_id UUID NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (batch_id, member_id),
  FOREIGN KEY (batch_id, class_id)
    REFERENCES in_app_reminder_batches (id, class_id) ON DELETE CASCADE,
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT in_app_reminder_recipients_resolved_time_check CHECK (
    resolved_at IS NULL OR resolved_at >= created_at
  )
);

CREATE INDEX in_app_reminder_recipients_home_unresolved_index
  ON in_app_reminder_recipients (
    class_id, member_id, created_at DESC, batch_id
  )
  WHERE resolved_at IS NULL;
CREATE INDEX in_app_reminder_recipients_member_batch_unresolved_index
  ON in_app_reminder_recipients (member_id, batch_id)
  WHERE resolved_at IS NULL;

CREATE FUNCTION enforce_in_app_reminder_recipient_resolution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at THEN
    RETURN NEW;
  END IF;

  IF OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'in-app reminder resolution is one-way and cannot be cleared or changed';
END
$$;

CREATE TRIGGER in_app_reminder_recipients_resolution_guard
BEFORE UPDATE OF resolved_at ON in_app_reminder_recipients
FOR EACH ROW EXECUTE FUNCTION enforce_in_app_reminder_recipient_resolution();

REVOKE ALL PRIVILEGES
  ON FUNCTION enforce_in_app_reminder_recipient_resolution()
  FROM PUBLIC, classhub_app, classhub_worker, classhub_retention,
    classhub_operator;

DO $optional_local_admin_function_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin') THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON FUNCTION enforce_in_app_reminder_recipient_resolution() FROM classhub_local_admin';
  END IF;
END
$optional_local_admin_function_acl$;

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
            'published_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at'
          ]
        )
      WHEN action LIKE 'supply.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY['supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at']
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY['supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at']
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
  ),
  ADD CONSTRAINT audit_logs_reminder_created_shape_check CHECK (
    action NOT IN ('notice.reminder_created', 'supply.reminder_created')
    OR (
      (
        (action = 'notice.reminder_created' AND target_type = 'notice')
        OR
        (action = 'supply.reminder_created' AND target_type = 'supply')
      )
      AND target_id ~ '^[1-9][0-9]*$'
      AND target_snapshot IS NULL
      AND before_json IS NULL
      AND reason IS NULL
      AND jsonb_typeof(after_json) = 'object'
      AND after_json ?& ARRAY[
        'reminder_batch_id', 'content_revision', 'current_unresolved_count',
        'created_count', 'cooldown_suppressed_count'
      ]
      AND jsonb_typeof(after_json -> 'reminder_batch_id') = 'string'
      AND (after_json ->> 'reminder_batch_id') ~* (
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-'
        '[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      AND jsonb_typeof(after_json -> 'content_revision') = 'string'
      AND (after_json ->> 'content_revision') ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(after_json -> 'current_unresolved_count') = 'number'
      AND (after_json ->> 'current_unresolved_count') ~ '^(0|[1-9][0-9]*)$'
      AND jsonb_typeof(after_json -> 'created_count') = 'number'
      AND (after_json ->> 'created_count') ~ '^(0|[1-9][0-9]*)$'
      AND jsonb_typeof(after_json -> 'cooldown_suppressed_count') = 'number'
      AND (after_json ->> 'cooldown_suppressed_count') ~ '^(0|[1-9][0-9]*)$'
    )
  );

REVOKE ALL PRIVILEGES ON
  in_app_reminder_batches,
  in_app_reminder_recipients
  FROM PUBLIC, classhub_app, classhub_worker, classhub_retention,
    classhub_operator;

DO $optional_local_admin_table_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin') THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON in_app_reminder_batches, in_app_reminder_recipients FROM classhub_local_admin';
  END IF;
END
$optional_local_admin_table_acl$;

GRANT SELECT, INSERT ON in_app_reminder_batches TO classhub_app;
GRANT SELECT, INSERT ON in_app_reminder_recipients TO classhub_app;
GRANT UPDATE (resolved_at) ON in_app_reminder_recipients TO classhub_app;

-- Down Migration

DO $in_app_reminders_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM in_app_reminder_recipients)
    OR EXISTS (SELECT 1 FROM in_app_reminder_batches) THEN
    RAISE EXCEPTION
      'in-app reminder rollback requires reminder tables to be empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_logs
    WHERE action IN ('notice.reminder_created', 'supply.reminder_created')
  ) THEN
    RAISE EXCEPTION
      'in-app reminder rollback requires reminder audit rows to be empty';
  END IF;
END
$in_app_reminders_rollback_guard$;

REVOKE SELECT, INSERT ON in_app_reminder_recipients FROM classhub_app;
REVOKE UPDATE (resolved_at) ON in_app_reminder_recipients FROM classhub_app;
REVOKE SELECT, INSERT ON in_app_reminder_batches FROM classhub_app;

DROP TRIGGER in_app_reminder_recipients_resolution_guard
  ON in_app_reminder_recipients;
DROP FUNCTION enforce_in_app_reminder_recipient_resolution();
DROP TABLE in_app_reminder_recipients;
DROP TABLE in_app_reminder_batches;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_reminder_created_shape_check,
  DROP CONSTRAINT audit_logs_action_check,
  DROP CONSTRAINT audit_logs_json_allowlist_check;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted', 'supply.created',
    'supply.updated', 'supply.deleted', 'schedule.created', 'schedule.updated',
    'schedule.deleted', 'attendance_notification.created',
    'attendance_notification.updated', 'attendance_notification.canceled',
    'attendance_notification.acknowledged'
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
      WHEN action LIKE 'notice.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'notice_id', 'title', 'is_important', 'content_revision',
            'published_at', 'deleted_at'
          ]
        )
      WHEN action LIKE 'supply.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY['supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at']
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY['supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['supply_id', 'title', 'needed_on', 'content_revision', 'deleted_at']
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
