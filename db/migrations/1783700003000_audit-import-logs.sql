-- Up Migration

CREATE FUNCTION jsonb_has_only_keys(payload JSONB, allowed_keys TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT payload IS NULL OR (
    jsonb_typeof(payload) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(payload) AS item(key)
      WHERE NOT (item.key = ANY(allowed_keys))
    )
  )
$$;

CREATE TABLE operator_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type TEXT NOT NULL,
  operator_id BIGINT REFERENCES operators (id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  checksum TEXT,
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_audit_logs_run_action_target_unique UNIQUE (
    run_id, action, target_type, target_id
  ),
  CONSTRAINT operator_audit_logs_actor_type_check CHECK (actor_type IN ('operator', 'system')),
  CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.transferred', 'teacher.revoked', 'class.suspended', 'class.archived',
    'class.reactivated', 'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'retention.executed'
  )),
  CONSTRAINT operator_audit_logs_actor_check CHECK (
    (actor_type = 'operator' AND operator_id IS NOT NULL)
    OR
    (
      actor_type = 'system' AND operator_id IS NULL
      AND action IN (
        'operator.bootstrapped', 'operator.credential_recovered', 'retention.executed'
      )
    )
  ),
  CONSTRAINT operator_audit_logs_target_check CHECK (
    btrim(target_type) <> '' AND btrim(target_id) <> ''
  ),
  CONSTRAINT operator_audit_logs_checksum_check CHECK (
    checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'operator.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['operator_id', 'status'])
        AND jsonb_has_only_keys(after_json, ARRAY['operator_id', 'status'])
      WHEN action LIKE 'teacher.%' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['teacher_user_id', 'teacher_profile_status', 'class_id', 'reason']
        )
      WHEN action LIKE 'class.%' THEN
        jsonb_has_only_keys(
          before_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
        AND jsonb_has_only_keys(
          after_json, ARRAY['class_id', 'status', 'teacher_user_id', 'reason']
        )
      WHEN action LIKE 'user.%' THEN
        jsonb_has_only_keys(before_json, ARRAY['user_id', 'is_active', 'reason'])
        AND jsonb_has_only_keys(after_json, ARRAY['user_id', 'is_active', 'reason'])
      WHEN action IN ('school.imported', 'meal.imported') THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'file_name', 'checksum', 'result', 'inserted_count', 'updated_count',
            'deleted_count', 'skipped_count', 'failed_count'
          ]
        )
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  )
);

CREATE TABLE school_import_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE,
  operator_id BIGINT NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  inserted_count INTEGER NOT NULL,
  updated_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_json JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT school_import_logs_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT school_import_logs_counts_check CHECK (
    inserted_count >= 0 AND updated_count >= 0
    AND skipped_count >= 0 AND failed_count >= 0
  ),
  CONSTRAINT school_import_logs_result_check CHECK (result IN ('success', 'failed')),
  CONSTRAINT school_import_logs_time_check CHECK (started_at <= completed_at)
);

CREATE TABLE meal_import_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE,
  operator_id BIGINT NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  inserted_count INTEGER NOT NULL,
  updated_count INTEGER NOT NULL,
  deleted_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_json JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meal_import_logs_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meal_import_logs_counts_check CHECK (
    inserted_count >= 0 AND updated_count >= 0 AND deleted_count >= 0
    AND skipped_count >= 0 AND failed_count >= 0
  ),
  CONSTRAINT meal_import_logs_result_check CHECK (result IN ('success', 'failed')),
  CONSTRAINT meal_import_logs_time_check CHECK (started_at <= completed_at)
);

CREATE TABLE audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  actor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  actor_member_id BIGINT REFERENCES class_members (id) ON DELETE SET NULL,
  actor_display_name_snapshot TEXT NOT NULL,
  actor_role_snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_snapshot JSONB,
  before_json JSONB,
  after_json JSONB,
  reason TEXT,
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted', 'supply.created',
    'supply.updated', 'supply.deleted', 'schedule.created', 'schedule.updated',
    'schedule.deleted'
  )),
  CONSTRAINT audit_logs_actor_role_check CHECK (
    actor_role_snapshot IN ('teacher', 'student', 'operator')
  ),
  CONSTRAINT audit_logs_target_check CHECK (
    btrim(target_type) <> '' AND btrim(target_id) <> ''
  ),
  CONSTRAINT audit_logs_reason_check CHECK (reason IS NULL OR char_length(reason) <= 300),
  CONSTRAINT audit_logs_json_allowlist_check CHECK (
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
  )
);

CREATE INDEX audit_logs_class_created_index
  ON audit_logs (class_id, created_at DESC, id DESC);

CREATE FUNCTION validate_audit_actor_class() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM class_members
    WHERE id = NEW.actor_member_id AND class_id = NEW.class_id
  ) THEN
    RAISE EXCEPTION 'audit actor member does not belong to audit class';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_logs_actor_class_validate
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION validate_audit_actor_class();

CREATE TABLE security_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  actor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  actor_email_hmac TEXT,
  hmac_key_version TEXT,
  actor_ip INET,
  actor_class_id BIGINT REFERENCES classes (id) ON DELETE SET NULL,
  target_class_id BIGINT,
  action TEXT NOT NULL,
  resource TEXT,
  sanitized_path TEXT NOT NULL,
  method TEXT NOT NULL,
  deny_reason TEXT,
  failure_code TEXT,
  request_id UUID NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT security_audit_logs_action_check CHECK (action IN (
    'auth.login_failed', 'auth.password_reset_requested',
    'auth.password_reset_completed', 'auth.logout', 'auth.csrf_failed',
    'authz.denied', 'rate_limited', 'email.delivery_failed', 'account.deleted'
  )),
  CONSTRAINT security_audit_logs_hmac_check CHECK (
    (actor_email_hmac IS NULL AND hmac_key_version IS NULL)
    OR (actor_email_hmac IS NOT NULL AND hmac_key_version IS NOT NULL)
  )
);

CREATE INDEX security_audit_logs_created_index ON security_audit_logs (created_at);

GRANT SELECT, INSERT ON audit_logs TO classhub_app;
REVOKE UPDATE, DELETE ON audit_logs FROM classhub_app;
GRANT SELECT, INSERT ON security_audit_logs TO classhub_worker;
GRANT SELECT, DELETE ON
  audit_logs, security_audit_logs, operator_audit_logs,
  school_import_logs, meal_import_logs, api_idempotency_keys,
  sessions, email_verification_tokens, password_reset_tokens
  TO classhub_retention;

-- Down Migration

DROP TABLE security_audit_logs;
DROP TRIGGER audit_logs_actor_class_validate ON audit_logs;
DROP FUNCTION validate_audit_actor_class();
DROP TABLE audit_logs;
DROP TABLE meal_import_logs;
DROP TABLE school_import_logs;
DROP TABLE operator_audit_logs;
DROP FUNCTION jsonb_has_only_keys(JSONB, TEXT[]);
