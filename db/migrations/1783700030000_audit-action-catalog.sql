-- Up Migration

/*
 * 왜 이 마이그레이션이 있나 — T-HUB-21 (A안: 반쪽만).
 *
 * 감사 action 목록이 CHECK 제약 안에 51개 문자열로 들어 있어서, 값 하나를
 * 더하려면 목록 전체를 손으로 다시 적어야 했다. 그 재작성에서 남이 더한 값을
 * 빠뜨리는 사고가 이 저장소에서 두 번 났다(T-HUB-02 · T-HUB-10). 2026-08-07
 * T-HUB-16에서도 아홉 걸음 전 파일을 베끼려다 seat_draw.adjusted를 날릴 뻔했다.
 *
 * 목록을 표로 옮기면 값 추가가 INSERT 한 줄이 되어 그 사고 유형이 구조적으로
 * 사라진다. FK는 CHECK와 마찬가지로 선언적이고 스키마에 그대로 보이므로
 * "제약이 눈에서 사라지는" 대가를 치르지 않는다.
 *
 * JSON 키 허용목록(audit_logs_json_allowlist_check)은 일부러 그대로 둔다.
 * 그쪽을 트리거로 내리면 검사가 보이지 않게 되는데, 그 대가가 이득보다 크다고
 * 판정했다(2026-08-11 실측 — 그쪽은 12갈래 계열 패턴이라 action 추가와 달리
 * 자주 바뀌지 않는다).
 */
CREATE TABLE audit_log_actions (
  action TEXT PRIMARY KEY
);

COMMENT ON TABLE audit_log_actions IS
  '감사 로그가 쓸 수 있는 action 목록. 값 추가는 INSERT 한 줄이다 (T-HUB-21).';

INSERT INTO audit_log_actions (action) VALUES
  ('class.created'), ('class.updated'), ('class.suspended'), ('class.reactivated'),
  ('class.archived'), ('invite_code.created'), ('invite_code.revoked'),
  ('member.requested'), ('member.request_canceled'), ('member.approved'),
  ('member.rejected'), ('member.left'), ('member.removed'), ('member.rejoin_allowed'),
  ('member.profile_updated'), ('member.account_deleted'), ('class.teacher_transferred'),
  ('notice.created'), ('notice.updated'), ('notice.deleted'),
  ('notice.reminder_created'),
  ('supply.created'), ('supply.updated'), ('supply.deleted'),
  ('supply.reminder_created'),
  ('schedule.created'), ('schedule.updated'), ('schedule.deleted'),
  ('attendance_notification.created'), ('attendance_notification.updated'),
  ('attendance_notification.canceled'), ('attendance_notification.acknowledged'),
  ('poll.created'), ('poll.deleted'),
  ('seat_draw.created'), ('seat_draw.adjusted'), ('seat_draw.published'),
  ('seat_draw.superseded'), ('seat_draw.deleted'),
  ('team_draw.created'), ('team_draw.adjusted'), ('team_draw.published'),
  ('team_draw.superseded'), ('team_draw.deleted'),
  ('duty_role.created'), ('duty_role.updated'), ('duty_role.archived'),
  ('duty_roster.created'), ('duty_roster.published'), ('duty_roster.superseded'),
  ('duty_roster.deleted');

/*
 * 옮겨 적다가 한 줄을 흘리면 그 action이 조용히 금지된다 — 이 마이그레이션이
 * 막으려는 사고가 이 마이그레이션 안에서 재현되는 셈이다. 옮긴 개수를 못박는다.
 * (중복은 PRIMARY KEY가 이미 막는다.)
 */
DO $audit_action_catalog_seed_guard$
BEGIN
  IF (SELECT count(*) FROM audit_log_actions) <> 51 THEN
    RAISE EXCEPTION
      'audit action catalog seed drifted: expected 51 rows, got %',
      (SELECT count(*) FROM audit_log_actions);
  END IF;
END
$audit_action_catalog_seed_guard$;

/*
 * 이미 쌓인 감사 행이 목록에 없는 action을 들고 있으면 아래 FK 생성이 실패한다.
 * Postgres가 내는 오류는 어느 값이 문제인지 알려주지 않으므로 먼저 이름을 뱉는다.
 */
DO $audit_action_catalog_existing_rows_guard$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(DISTINCT logs.action, ', ')
    INTO missing
    FROM audit_logs AS logs
    LEFT JOIN audit_log_actions AS catalog ON catalog.action = logs.action
   WHERE catalog.action IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'audit rows use actions missing from the catalog: %', missing;
  END IF;
END
$audit_action_catalog_existing_rows_guard$;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check;

/*
 * ON UPDATE는 일부러 RESTRICT다. CASCADE로 두면 목록에서 이름을 고칠 때 이미
 * 쌓인 감사 기록의 action이 함께 바뀐다 — append-only 원장에서 과거를 고쳐
 * 쓰는 일이라 허용하면 안 된다.
 */
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_catalog_fkey
  FOREIGN KEY (action) REFERENCES audit_log_actions (action)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

/*
 * 런타임 역할은 REVOKE ALL 뒤 선별 GRANT다(1783700004000). 새 표에도 읽기를
 * 준다 — 앱이 목록을 확인할 수 있어야 하고, 권한 누락으로 감사 기록이 통째로
 * 막히는 사고를 피한다(T-HUB-08에서 GRANT 누락으로 이관이 깨진 선례).
 */
GRANT SELECT ON audit_log_actions TO classhub_app;

-- Down Migration

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_catalog_fkey;

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
  ));

REVOKE ALL PRIVILEGES ON audit_log_actions FROM classhub_app;

DROP TABLE audit_log_actions;
