-- Up Migration

-- 담임 이관은 그 반 전원의 이름·학번·출결·기명 투표를 볼 수 있는 사람이 통째로
-- 바뀌는 사건인데, 지금은 운영자 감사에만 남고 학급 감사에는 남지 않는다. 신임·전임
-- 교사 누구도 "언제 누구에게 넘어갔는지"를 앱에서 볼 수 없다(PRD_FINAL 679).
-- class.teacher_transferred는 action CHECK·JSON allowlist·OpenAPI 계약·sanitizer가
-- 모두 준비돼 있고 쓰는 코드만 없었다. 그 코드를 붙이려면 이 권한이 먼저다 —
-- 이관 CLI는 classhub_operator로 접속하므로, 권한 없이 INSERT만 넣으면 지금 잘
-- 되던 이관이 운영에서 통째로 깨진다.

-- 이관이 실제로 쓰는 열만 연다.
--   · actor_user_id·actor_member_id는 주지 않는다 — 운영자는 학급 구성원이 아니므로
--     둘 다 NULL로 남아야 하고, 열지 않으면 NULL 외의 값을 넣을 수 없다.
--   · SELECT는 주지 않는다. 학급 감사를 읽는 것은 교사용 화면의 몫이고, 운영자가
--     학생 활동 이력을 열람할 이유가 없다.
--   · 이 표는 append-only다. UPDATE·DELETE는 어떤 롤에도 열려 있지 않으며 여기서도 아니다.
GRANT INSERT (
  class_id,
  actor_display_name_snapshot,
  actor_role_snapshot,
  action,
  target_type,
  target_id,
  target_snapshot,
  before_json,
  after_json,
  reason,
  request_id
) ON audit_logs TO classhub_operator;

-- Down Migration

REVOKE INSERT (
  class_id,
  actor_display_name_snapshot,
  actor_role_snapshot,
  action,
  target_type,
  target_id,
  target_snapshot,
  before_json,
  after_json,
  reason,
  request_id
) ON audit_logs FROM classhub_operator;
