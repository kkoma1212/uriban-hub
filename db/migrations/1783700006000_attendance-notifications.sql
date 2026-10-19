-- Up Migration

CREATE TABLE attendance_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  member_id BIGINT NOT NULL,
  notification_date DATE NOT NULL,
  notification_type TEXT NOT NULL,
  expected_time TIME(0) WITHOUT TIME ZONE,
  status TEXT NOT NULL DEFAULT 'pending',
  row_version BIGINT NOT NULL DEFAULT 1,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by_member_id BIGINT,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendance_notifications_class_member_date_unique UNIQUE (
    class_id, member_id, notification_date
  ),
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (acknowledged_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_notifications_type_check CHECK (
    notification_type IN ('late', 'absent', 'early')
  ),
  CONSTRAINT attendance_notifications_expected_time_check CHECK (
    (
      notification_type IN ('late', 'early')
      AND expected_time IS NOT NULL
    )
    OR
    (
      notification_type = 'absent'
      AND expected_time IS NULL
    )
  ),
  CONSTRAINT attendance_notifications_expected_time_seconds_check CHECK (
    expected_time IS NULL OR EXTRACT(SECOND FROM expected_time) = 0
  ),
  CONSTRAINT attendance_notifications_status_check CHECK (
    status IN ('pending', 'acknowledged', 'canceled')
  ),
  CONSTRAINT attendance_notifications_acknowledgement_check CHECK (
    (
      status = 'acknowledged'
      AND acknowledged_by_member_id IS NOT NULL
      AND acknowledged_at IS NOT NULL
    )
    OR
    (
      status IN ('pending', 'canceled')
      AND acknowledged_by_member_id IS NULL
      AND acknowledged_at IS NULL
    )
  ),
  CONSTRAINT attendance_notifications_row_version_check CHECK (row_version >= 1)
);

CREATE INDEX attendance_notifications_class_date_status_index
  ON attendance_notifications (class_id, notification_date, status, id);
CREATE INDEX attendance_notifications_member_date_index
  ON attendance_notifications (member_id, notification_date DESC);

DROP INDEX notices_importance_index;
CREATE INDEX notices_importance_index
  ON notices (class_id, is_important DESC, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

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
  ),
  ADD CONSTRAINT audit_logs_attendance_reason_check CHECK (
    action NOT LIKE 'attendance_notification.%' OR reason IS NULL
  );

REVOKE ALL PRIVILEGES ON attendance_notifications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON attendance_notifications_id_seq FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON attendance_notifications TO classhub_app;
GRANT USAGE ON SEQUENCE attendance_notifications_id_seq TO classhub_app;
GRANT SELECT, DELETE ON attendance_notifications TO classhub_retention;
GRANT INSERT ON operator_audit_logs TO classhub_retention;
GRANT USAGE ON SEQUENCE operator_audit_logs_id_seq TO classhub_retention;

-- Down Migration

DO $attendance_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM attendance_notifications) THEN
    RAISE EXCEPTION
      'attendance migration rollback requires attendance_notifications to be empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM audit_logs WHERE action LIKE 'attendance_notification.%'
  ) THEN
    RAISE EXCEPTION
      'attendance migration rollback requires attendance notification audit rows to be empty';
  END IF;
END
$attendance_rollback_guard$;

REVOKE INSERT ON operator_audit_logs FROM classhub_retention;
REVOKE USAGE ON SEQUENCE operator_audit_logs_id_seq FROM classhub_retention;
REVOKE ALL PRIVILEGES ON attendance_notifications FROM classhub_app, classhub_retention;
REVOKE ALL PRIVILEGES ON attendance_notifications_id_seq FROM classhub_app;

DROP TABLE attendance_notifications;

DROP INDEX notices_importance_index;
CREATE INDEX notices_importance_index
  ON notices (class_id, is_important, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  DROP CONSTRAINT audit_logs_json_allowlist_check,
  DROP CONSTRAINT audit_logs_attendance_reason_check;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted', 'supply.created',
    'supply.updated', 'supply.deleted', 'schedule.created', 'schedule.updated',
    'schedule.deleted'
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
