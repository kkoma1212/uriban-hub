-- Up Migration

/*
 * 법정공휴일 표 (Round 5 §1 — 달력의 "빨간 날").
 *
 * **왜 새 표인가**: 이 저장소에는 공휴일이라는 개념이 한 곳도 없었다(2026-08-25 실측:
 * apps·packages·db 전체에서 `holiday|공휴일|휴일` 0건). 달력이 일요일·토요일은 요일
 * 계산으로 알 수 있지만, 광복절이 며칠인지는 알 방법이 없다.
 *
 * **왜 school_schedule_events 를 재활용하지 않나**: 그 표의 `school_day_type` 은 NEIS 의
 * 수업일/휴업일 구분이다. 재량휴업일도 휴업일이고, 학교가 NEIS 에 올려야만 존재하며,
 * 학교마다 다르다. "법정공휴일"과 겹치는 날이 많을 뿐 같은 것이 아니다. 겹친다고
 * 재활용하면 달력이 "이 학교가 쉬는 날"과 "나라가 정한 빨간 날"을 구분하지 못한다.
 *
 * **왜 학교·학급 외래키가 없나**: 법정공휴일은 전국 공통이다. 반마다 복제하면 같은
 * 날짜가 반 수만큼 늘어나고, 대체공휴일이 나중에 확정될 때 갱신할 자리도 그만큼 늘어난다.
 *
 * **왜 날짜가 기본키인가**: 하루에 공휴일이 둘일 수 없다. 별도 id 를 두면 같은 날짜가
 * 두 줄 들어가는 것을 막을 장치를 따로 만들어야 한다. 동기화가 UPSERT 한 줄로 끝난다.
 *
 * **갱신은 한 번으로 끝나지 않는다**: 공공데이터포털이 명시하기를 대체공휴일은
 * "법제처 심사·국무회의·대통령 승인을 거쳐 관보에 정식 공포된 이후에 적용"된다.
 * 즉 내년 달력을 미리 받아두면 대체공휴일이 빠져 있을 수 있다. 그래서 `source_loaded_on`
 * 을 남겨 언제 받은 값인지 보이게 하고, 운영자가 다시 돌리면 덮어쓰도록 UPSERT 로 둔다.
 */

CREATE TABLE public_holidays (
  holiday_date DATE PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_loaded_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT public_holidays_name_check CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 60
    AND name !~ '[[:cntrl:]]'
  ),
  /*
   * 출처를 값으로 못박는다. 나중에 다른 공급처를 더할 때 이 목록을 넓히게 되는데,
   * 그 순간이 "어느 값이 어디서 왔는가"를 다시 생각하는 자리가 된다.
   */
  CONSTRAINT public_holidays_source_check CHECK (source IN ('kasi')),
  /*
   * 오타 한 번으로 서기 202년이나 20260년이 들어가면 달력이 조용히 이상해진다.
   * school_schedule_events 의 academic_year 검사와 같은 범위를 쓴다.
   */
  CONSTRAINT public_holidays_date_range_check CHECK (
    holiday_date BETWEEN DATE '2020-01-01' AND DATE '2100-12-31'
  )
);

COMMENT ON TABLE public_holidays IS
  '전국 공통 법정공휴일. 출처는 한국천문연구원 특일 정보(공공데이터포털).';

/*
 * ⚠️ 이 목록은 통째로 다시 쓰는 방식이라, 그동안 다른 마이그레이션이 더한 값을
 * 빠뜨리면 조용히 없앤다(이 저장소에서 두 번 사고가 났다 — T-HUB-02 · T-HUB-10).
 * 현재 기준 출처는 3000(최초)·13000(school_schedule.imported)·22000(teacher.password_reset)
 * ·27000(reminder.executed · job.failed)이고, 27000 이후 이 제약을 건드린 마이그레이션은
 * 없음을 확인했다(2026-08-25, db/migrations 전체를 operator_audit_logs_action_check 로 grep).
 * (주석 안에 슬래시+별표를 적지 말 것 — PostgreSQL 은 블록 주석 중첩을 지원해서
 *  그 두 글자가 새 주석을 열고, 이 마이그레이션이 통째로 파싱에 실패한다. 실제로 겪었다.)
 * 아래는 27000 의 20개에 `holiday.imported` 하나만 더한 21개다.
 */
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_action_check,
  ADD CONSTRAINT operator_audit_logs_action_check CHECK (action IN (
    'operator.bootstrapped', 'operator.created', 'operator.revoked',
    'operator.token_rotated', 'operator.credential_recovered', 'teacher.created',
    'teacher.password_reset', 'teacher.transferred', 'teacher.revoked',
    'class.suspended', 'class.archived', 'class.reactivated',
    'user.deactivated', 'user.reactivated', 'school.imported',
    'meal.imported', 'school_schedule.imported', 'holiday.imported',
    'retention.executed', 'reminder.executed', 'job.failed'
  )),
  /*
   * `holiday.imported` 는 다른 가져오기와 남기는 것이 똑같다 — 무엇을 몇 건 넣고
   * 고쳤는지. 그래서 새 갈래를 만들지 않고 기존 가져오기 갈래에 이름만 더한다.
   * 갈래를 늘리면 이 CHECK 를 다음에 손보는 사람이 볼 것이 하나 더 늘어난다.
   */
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
        'school_schedule.imported',
        'holiday.imported'
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

/*
 * 앱은 읽기만 한다. 공휴일을 바꾸는 것은 운영자의 동기화 명령뿐이며, 교사·학생 화면
 * 어디에도 공휴일을 고치는 자리가 없다.
 *
 * 열 단위 GRANT 를 쓰지 않은 이유: 이 표에는 개인정보도 학급 경계도 없다. 전국 공통
 * 공개 데이터 여섯 칸뿐이라 열을 나눠 잠글 것이 없다.
 */
GRANT SELECT ON public_holidays TO classhub_app;
GRANT SELECT, INSERT, UPDATE ON public_holidays TO classhub_operator;

-- Down Migration

/*
 * 이미 남은 감사 기록이 있는데 되돌리면 CHECK 가 거부하며 알 수 없는 오류를 낸다.
 * 27000 이 쓴 방식 그대로, 무엇이 막고 있는지 먼저 말해준다.
 */
DO $public_holidays_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM operator_audit_logs WHERE action = 'holiday.imported') THEN
    RAISE EXCEPTION
      'operator_audit_logs still holds holiday.imported rows; '
      'remove or migrate them before rolling back';
  END IF;
END
$public_holidays_rollback_guard$;

REVOKE SELECT, INSERT, UPDATE ON public_holidays FROM classhub_operator;
REVOKE SELECT ON public_holidays FROM classhub_app;

-- 27000 이 남긴 상태로 되돌린다(holiday.imported 만 뺀다).
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
      WHEN action = 'reminder.executed' THEN
        jsonb_has_only_keys(
          before_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
        AND jsonb_has_only_keys(
          after_json,
          ARRAY['eligible_count', 'sent_count', 'failed_count', 'window_ends_at']
        )
      WHEN action = 'job.failed' THEN
        jsonb_has_only_keys(before_json, ARRAY['job_name', 'error_name'])
        AND jsonb_has_only_keys(after_json, ARRAY['job_name', 'error_name'])
      ELSE
        jsonb_has_only_keys(before_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
        AND jsonb_has_only_keys(after_json, ARRAY['cutoff_at', 'table_name', 'deleted_count'])
    END
  );

DROP TABLE public_holidays;
