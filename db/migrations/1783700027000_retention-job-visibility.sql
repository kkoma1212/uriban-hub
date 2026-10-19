-- Up Migration

-- 보관기간 잡이 돌았는지 아무도 모르는 상태를 고친다(T-HUB-10).
--
--   · 안내 메일 잡은 감사 기록을 아예 남기지 않아, SMTP 설정이 만료돼 전량 실패해도
--     알 사람이 없었다. 성공·실패 건수를 남기는 reminder.executed를 연다.
--   · 삭제 잡의 감사 기록은 삭제와 같은 트랜잭션 안에 있어서, 롤백되면 기록도 함께
--     사라졌다 — "돌았는데 실패"와 "아예 안 돎"이 구분되지 않았다. 트랜잭션 밖에서
--     남기는 job.failed를 연다.
--
-- 삭제 잡을 retention.executed로 재사용하지 않고 이름을 나눈 것은, 1년 뒤에 이 표를
-- 읽는 사람이 "지운 작업"과 "메일 보낸 작업"을 구분할 수 있어야 하기 때문이다.

-- ⚠️ 이 목록은 통째로 다시 쓰는 방식이라, 그동안 다른 마이그레이션이 더한 값을
-- 빠뜨리면 조용히 없앤다. 현재 기준 출처는 3000(최초)·13000(school_schedule.imported)·
-- 22000(teacher.password_reset)이다. 다음에 고치는 사람은 그 셋을 먼저 확인할 것.
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.password_reset', 'teacher.transferred', 'teacher.revoked',
    'class.suspended', 'class.archived', 'class.reactivated',
    'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'retention.executed',
    'reminder.executed', 'job.failed'
  )),
  -- 두 기록 모두 운영자가 아니라 잡이 남긴다. 운영자 신원 없이 쓸 수 있어야 한다.
  DROP CONSTRAINT operator_audit_logs_actor_check,
  ADD CONSTRAINT operator_audit_logs_actor_check CHECK (
    (actor_type = 'operator' AND operator_id IS NOT NULL)
    OR
    (
      actor_type = 'system' AND operator_id IS NULL
      AND action IN (
        'operator.bootstrapped', 'operator.credential_recovered', 'retention.executed',
        'reminder.executed', 'job.failed'
      )
    )
  ),
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
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
      WHEN action IN (
        'school.imported',
        'meal.imported',
        'school_schedule.imported'
      ) THEN
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
      -- 받는 사람 주소도 교사 신원도 넣지 않는다. 건수만으로 "전량 실패"를 알 수 있다.
      WHEN action = 'reminder.executed' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
      -- 예외 메시지 원문은 넣지 않는다. 내부 경로·식별자가 새는 경로가 된다.
      WHEN action = 'job.failed' THEN
        jsonb_has_only_keys(before_json, ARRAY['job_name', 'error_name'])
        AND jsonb_has_only_keys(after_json, ARRAY['job_name', 'error_name'])
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  );

-- Down Migration

-- 새 종류의 기록이 이미 쌓였는데 되돌리면 CHECK가 거부하며 알 수 없는 오류를 낸다.
-- 무엇이 막고 있는지 먼저 말해준다.
DO $retention_job_visibility_rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM operator_audit_logs
    WHERE action IN ('reminder.executed', 'job.failed')
  ) THEN
    RAISE EXCEPTION
      'operator_audit_logs still holds reminder.executed or job.failed rows; '
      'remove or migrate them before rolling back';
  END IF;
END
$retention_job_visibility_rollback_guard$;

-- 22000이 남긴 상태로 되돌린다(teacher.password_reset 포함).
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.password_reset', 'teacher.transferred', 'teacher.revoked',
    'class.suspended', 'class.archived', 'class.reactivated',
    'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'retention.executed'
  )),
  DROP CONSTRAINT operator_audit_logs_actor_check,
  ADD CONSTRAINT operator_audit_logs_actor_check CHECK (
    (actor_type = 'operator' AND operator_id IS NOT NULL)
    OR
    (
      actor_type = 'system' AND operator_id IS NULL
      AND action IN (
        'operator.bootstrapped', 'operator.credential_recovered', 'retention.executed'
      )
    )
  ),
  DROP CONSTRAINT operator_audit_logs_json_allowlist_check,
  ADD CONSTRAINT operator_audit_logs_json_allowlist_check CHECK (
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
      WHEN action IN (
        'school.imported',
        'meal.imported',
        'school_schedule.imported'
      ) THEN
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
  );
