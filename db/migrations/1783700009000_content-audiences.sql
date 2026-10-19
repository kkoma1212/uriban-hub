-- Up Migration

ALTER TABLE notices
  ADD COLUMN audience_mode TEXT NOT NULL DEFAULT 'legacy_class',
  ADD COLUMN category TEXT NOT NULL DEFAULT 'general',
  ADD CONSTRAINT notices_audience_mode_check CHECK (
    audience_mode IN ('legacy_class', 'all_snapshot', 'selected_snapshot')
  ),
  ADD CONSTRAINT notices_category_check CHECK (
    category IN ('general', 'performance')
  );

ALTER TABLE supplies
  ADD COLUMN audience_mode TEXT NOT NULL DEFAULT 'legacy_class',
  ADD CONSTRAINT supplies_audience_mode_check CHECK (
    audience_mode IN ('legacy_class', 'all_snapshot', 'selected_snapshot')
  );

CREATE FUNCTION enforce_content_audience_mode_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.audience_mode IS DISTINCT FROM OLD.audience_mode THEN
    RAISE EXCEPTION 'published content audience_mode is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER notices_audience_mode_immutable
BEFORE UPDATE OF audience_mode ON notices
FOR EACH ROW EXECUTE FUNCTION enforce_content_audience_mode_immutable();

CREATE TRIGGER supplies_audience_mode_immutable
BEFORE UPDATE OF audience_mode ON supplies
FOR EACH ROW EXECUTE FUNCTION enforce_content_audience_mode_immutable();

REVOKE ALL PRIVILEGES
  ON FUNCTION enforce_content_audience_mode_immutable()
  FROM PUBLIC, classhub_app, classhub_worker, classhub_retention,
    classhub_operator;

DO $optional_local_admin_function_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin') THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON FUNCTION enforce_content_audience_mode_immutable() FROM classhub_local_admin';
  END IF;
END
$optional_local_admin_function_acl$;

CREATE TABLE notice_recipients (
  notice_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, member_id),
  FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE CASCADE,
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

CREATE INDEX notice_recipients_member_content_index
  ON notice_recipients (class_id, member_id, notice_id);

CREATE TABLE supply_recipients (
  supply_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supply_id, member_id),
  FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE CASCADE,
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

CREATE INDEX supply_recipients_member_content_index
  ON supply_recipients (class_id, member_id, supply_id);

CREATE INDEX notices_category_updates_index
  ON notices (class_id, category, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX supplies_updates_index
  ON supplies (class_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

REVOKE ALL PRIVILEGES ON
  notice_recipients,
  supply_recipients
  FROM PUBLIC, classhub_app, classhub_worker, classhub_retention,
    classhub_operator;

DO $optional_local_admin_table_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin') THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON notice_recipients, supply_recipients FROM classhub_local_admin';
  END IF;
END
$optional_local_admin_table_acl$;

GRANT SELECT, INSERT ON notice_recipients TO classhub_app;
GRANT SELECT, INSERT ON supply_recipients TO classhub_app;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_json_allowlist_check;

ALTER TABLE audit_logs
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

-- Down Migration

DO $content_audiences_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM notice_recipients)
    OR EXISTS (SELECT 1 FROM supply_recipients)
    OR EXISTS (
      SELECT 1 FROM notices
      WHERE audience_mode <> 'legacy_class' OR category <> 'general'
    )
    OR EXISTS (
      SELECT 1 FROM supplies
      WHERE audience_mode <> 'legacy_class'
    ) THEN
    RAISE EXCEPTION
      'content audience rollback requires all content to remain legacy and recipient tables to be empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM audit_logs
    WHERE action LIKE 'notice.%'
      AND (
        COALESCE(target_snapshot, '{}'::jsonb) ?| ARRAY[
          'category', 'audience_mode', 'recipient_count'
        ]
        OR COALESCE(before_json, '{}'::jsonb) ?| ARRAY[
          'category', 'audience_mode', 'recipient_count'
        ]
        OR COALESCE(after_json, '{}'::jsonb) ?| ARRAY[
          'category', 'audience_mode', 'recipient_count'
        ]
      )
  ) OR EXISTS (
    SELECT 1
    FROM audit_logs
    WHERE action LIKE 'supply.%'
      AND (
        COALESCE(target_snapshot, '{}'::jsonb) ?| ARRAY[
          'audience_mode', 'recipient_count'
        ]
        OR COALESCE(before_json, '{}'::jsonb) ?| ARRAY[
          'audience_mode', 'recipient_count'
        ]
        OR COALESCE(after_json, '{}'::jsonb) ?| ARRAY[
          'audience_mode', 'recipient_count'
        ]
      )
  ) THEN
    RAISE EXCEPTION
      'content audience rollback requires audience audit fields to be absent';
  END IF;
END
$content_audiences_rollback_guard$;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_json_allowlist_check;

ALTER TABLE audit_logs
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
  );

REVOKE SELECT, INSERT ON notice_recipients FROM classhub_app;
REVOKE SELECT, INSERT ON supply_recipients FROM classhub_app;

DROP TABLE notice_recipients;
DROP TABLE supply_recipients;

DROP INDEX notices_category_updates_index;
DROP INDEX supplies_updates_index;

DROP TRIGGER notices_audience_mode_immutable ON notices;
DROP TRIGGER supplies_audience_mode_immutable ON supplies;
DROP FUNCTION enforce_content_audience_mode_immutable();

ALTER TABLE notices
  DROP CONSTRAINT notices_audience_mode_check,
  DROP CONSTRAINT notices_category_check,
  DROP COLUMN audience_mode,
  DROP COLUMN category;

ALTER TABLE supplies
  DROP CONSTRAINT supplies_audience_mode_check,
  DROP COLUMN audience_mode;
