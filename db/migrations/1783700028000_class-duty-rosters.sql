-- Up Migration

/*
 * 1인 1역·당번 배정(T-HUB-16 1단계).
 *
 * 역할 목록을 배정본마다 입력하게 하지 않고 학급 자산으로 둔다. 이 기능의 값은
 * "학기 초 한 번 정하고 매주 로테이션"인데, 배정본마다 다시 입력하게 하면 그 값이
 * 사라진다. 그리고 직전 회피가 역할 **이름 문자열** 대조가 되어 부서진다 — "칠판"을
 * "칠판닦기"로 고치는 순간 회피가 조용히 풀린다. 학급 단위 표로 두면 id로 대조된다.
 *
 * 배정본은 team_draws 의 draft→published→superseded 전이와 row_version 을 그대로
 * 따른다. 새로 발명하지 않는다.
 */

CREATE TABLE class_duty_roles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  required_count SMALLINT NOT NULL,
  sort_index SMALLINT NOT NULL,
  -- 역할을 그만 쓰게 되어도 지우지 않는다. 과거 배정본이 참조하고 있어서
  -- ON DELETE RESTRICT 에 걸리고, 지워지면 "그때 누가 무엇을 했는지"가 사라진다.
  archived_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT class_duty_roles_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT class_duty_roles_name_check CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 20
    AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT class_duty_roles_counts_check CHECK (
    required_count BETWEEN 1 AND 60
    AND sort_index BETWEEN 1 AND 30
  ),
  CONSTRAINT class_duty_roles_row_version_check CHECK (row_version >= 1)
);

CREATE TABLE duty_rosters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  role_count SMALLINT NOT NULL,
  assigned_student_count SMALLINT NOT NULL,
  -- 역할을 못 받은 학생 수. 조용히 빠지면 교사가 누락을 못 보므로 수치로 남긴다.
  unassigned_student_count SMALLINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT duty_rosters_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT duty_rosters_creator_class_foreign_key
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT duty_rosters_title_check CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 80
    AND title !~ '[[:cntrl:]]'
  ),
  CONSTRAINT duty_rosters_counts_check CHECK (
    role_count BETWEEN 1 AND 30
    AND assigned_student_count BETWEEN 0 AND 60
    AND unassigned_student_count BETWEEN 0 AND 60
  ),
  CONSTRAINT duty_rosters_status_check CHECK (
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
  CONSTRAINT duty_rosters_row_version_check CHECK (row_version >= 1)
);

CREATE TABLE duty_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  duty_roster_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  duty_role_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  student_number_snapshot INTEGER,
  -- 역할 이름을 나중에 고쳐도 그때 이름이 남아야 한다. 표시명 스냅샷과 같은 이유다.
  role_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- 1인 1역: 한 배정본에서 한 학생은 한 역할만 받는다.
  CONSTRAINT duty_assignments_roster_member_unique
    UNIQUE (duty_roster_id, member_id),
  CONSTRAINT duty_assignments_roster_class_foreign_key
    FOREIGN KEY (duty_roster_id, class_id)
    REFERENCES duty_rosters (id, class_id) ON DELETE RESTRICT,
  -- 역할이 같은 학급 것인지를 FK가 보장한다(team_draws 가 트리거로 막은 것을
  -- 여기서는 복합 FK 하나로 끝낼 수 있어 트리거를 두지 않는다).
  CONSTRAINT duty_assignments_role_class_foreign_key
    FOREIGN KEY (duty_role_id, class_id)
    REFERENCES class_duty_roles (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT duty_assignments_member_class_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT duty_assignments_display_name_check CHECK (
    display_name_snapshot = btrim(display_name_snapshot)
    AND char_length(display_name_snapshot) BETWEEN 1 AND 20
    AND display_name_snapshot !~ '[[:cntrl:]]'
  ),
  CONSTRAINT duty_assignments_role_name_check CHECK (
    role_name_snapshot = btrim(role_name_snapshot)
    AND char_length(role_name_snapshot) BETWEEN 1 AND 20
    AND role_name_snapshot !~ '[[:cntrl:]]'
  ),
  CONSTRAINT duty_assignments_student_number_check CHECK (
    student_number_snapshot IS NULL
    OR student_number_snapshot BETWEEN 1 AND 99
  )
);

-- 살아 있는 역할끼리는 이름이 겹치지 않게. 보관된 역할의 이름은 다시 쓸 수 있다.
CREATE UNIQUE INDEX class_duty_roles_active_name_unique
  ON class_duty_roles (class_id, name)
  WHERE archived_at IS NULL;

CREATE INDEX class_duty_roles_class_order_index
  ON class_duty_roles (class_id, sort_index, id);

CREATE UNIQUE INDEX duty_rosters_one_published_per_class
  ON duty_rosters (class_id)
  WHERE status = 'published';

CREATE INDEX duty_rosters_class_history_index
  ON duty_rosters (class_id, created_at DESC, id DESC);

-- 직전 회피가 읽는 경로다. "이 학생이 지난 배정본에서 받은 역할"을 찾는다.
CREATE INDEX duty_assignments_member_index
  ON duty_assignments (member_id, duty_roster_id);

CREATE INDEX duty_assignments_roster_role_index
  ON duty_assignments (duty_roster_id, duty_role_id, id);

/*
 * 감사 허용 목록에 값을 더한다.
 *
 * ⚠️ 현재 유효한 정의가 두 제약에서 서로 다른 파일에 있다 — action_check 는
 * 1783700020000, json_allowlist_check 는 1783700018000 이 마지막으로 다시 썼다.
 * 두 목록을 통째로 다시 쓰는 방식이라, 베낄 파일을 잘못 고르면 그 사이에 남이 더한
 * 값이 조용히 사라진다. T-HUB-02 와 T-HUB-10 이 이 지점에서 두 번 데었다.
 * 018000 을 베꼈다면 seat_draw.adjusted 와 team_draw.adjusted 를 날렸을 것이다.
 */

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
    'seat_draw.created', 'seat_draw.adjusted', 'seat_draw.published',
    'seat_draw.superseded', 'seat_draw.deleted',
    'team_draw.created', 'team_draw.adjusted', 'team_draw.published',
    'team_draw.superseded', 'team_draw.deleted',
    'duty_role.created', 'duty_role.updated', 'duty_role.archived',
    'duty_roster.created', 'duty_roster.published', 'duty_roster.superseded',
    'duty_roster.deleted'
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
      WHEN action LIKE 'duty_role.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'duty_role_id', 'name', 'required_count', 'sort_index', 'archived_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'duty_role_id', 'name', 'required_count', 'sort_index', 'archived_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'duty_role_id', 'name', 'required_count', 'sort_index', 'archived_at'
          ]
        )
      WHEN action LIKE 'duty_roster.%' THEN
        jsonb_has_only_keys(
          target_snapshot,
          ARRAY[
            'duty_roster_id', 'title', 'role_count', 'assigned_student_count',
            'unassigned_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          before_json,
          ARRAY[
            'duty_roster_id', 'title', 'role_count', 'assigned_student_count',
            'unassigned_student_count', 'status', 'published_at',
            'superseded_at', 'deleted_at'
          ]
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY[
            'duty_roster_id', 'title', 'role_count', 'assigned_student_count',
            'unassigned_student_count', 'status', 'published_at',
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
  class_duty_roles, duty_rosters, duty_assignments
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  class_duty_roles_id_seq, duty_rosters_id_seq, duty_assignments_id_seq
FROM PUBLIC;

-- 역할은 편집·보관이 있어 UPDATE 가 필요하고, 배정본은 상태 전이 때문에 필요하다.
-- 배정 행은 만들고 지우기만 한다(team_draw_assignments 와 같다).
GRANT SELECT, INSERT, UPDATE, DELETE ON class_duty_roles TO classhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON duty_rosters TO classhub_app;
GRANT SELECT, INSERT, DELETE ON duty_assignments TO classhub_app;
GRANT USAGE ON SEQUENCE
  class_duty_roles_id_seq, duty_rosters_id_seq, duty_assignments_id_seq
TO classhub_app;

-- Down Migration

DO $class_duty_rosters_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM duty_assignments)
    OR EXISTS (SELECT 1 FROM duty_rosters)
    OR EXISTS (SELECT 1 FROM class_duty_roles) THEN
    RAISE EXCEPTION
      'duty roster rollback requires class_duty_roles, duty_rosters, and duty_assignments to be empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM audit_logs
    WHERE action LIKE 'duty_role.%' OR action LIKE 'duty_roster.%'
  ) THEN
    RAISE EXCEPTION
      'duty roster rollback requires duty role and duty roster audit rows to be empty';
  END IF;
END
$class_duty_rosters_rollback_guard$;

REVOKE ALL PRIVILEGES ON
  class_duty_roles, duty_rosters, duty_assignments
FROM classhub_app;
REVOKE ALL PRIVILEGES ON
  class_duty_roles_id_seq, duty_rosters_id_seq, duty_assignments_id_seq
FROM classhub_app;

DROP TABLE duty_assignments;
DROP TABLE duty_rosters;
DROP TABLE class_duty_roles;

/*
 * down 은 두 제약을 이 마이그레이션 직전 상태로 되돌린다 — action_check 는
 * 1783700020000 의 목록, json_allowlist_check 는 1783700018000 의 분기다.
 * (018000 의 down 이 json_allowlist 를 복원하지 않는 비대칭이 있으나 그건 기존
 *  상태이고 이 마이그레이션이 만든 것이 아니다. 여기서는 둘 다 되돌린다.)
 */

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
    'seat_draw.created', 'seat_draw.adjusted', 'seat_draw.published',
    'seat_draw.superseded', 'seat_draw.deleted',
    'team_draw.created', 'team_draw.adjusted', 'team_draw.published',
    'team_draw.superseded', 'team_draw.deleted'
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
