-- Up Migration

-- 반을 맡은 교사는 지금 revoke도 계정 삭제도 할 수 없다. PRD가 그 탈출구로
-- 지정한 "새 교사로 이관"이 구현되지 않았기 때문이다(PRD_FINAL 285·287·303·309,
-- 2026-08-01 감사 P0 권장수정 4). 스키마는 이미 이 작업을 전제하고 있다 —
-- 교사 멤버의 허용 상태에 'transferred'가 있고 상태 이력에 actor_operator_id가 있다.
-- 없는 것은 운영자 역할의 권한뿐이므로 그것만 연다.

-- 대상 반의 존재와 상태만 확인한다. 이름·정원 등은 읽을 필요가 없다.
GRANT SELECT (id, status) ON classes TO classhub_operator;

-- 담임 교체에 필요한 최소치. student_number·display_name_in_class는 건드리지
-- 않으므로 제외한다 — 운영자가 학생 명부를 고칠 수 있으면 안 된다.
GRANT SELECT (id, class_id, user_id, role, status, row_version),
  INSERT (class_id, user_id, role, status),
  UPDATE (status, status_changed_at, updated_at, row_version)
  ON class_members TO classhub_operator;

-- 이관은 반드시 이력을 남긴다. 이 표는 append-only이므로 INSERT만 준다.
GRANT INSERT (member_id, class_id, from_status, to_status, actor_operator_id, reason)
  ON class_member_status_history TO classhub_operator;

GRANT USAGE ON SEQUENCE
  class_members_id_seq,
  class_member_status_history_id_seq
  TO classhub_operator;

-- class_members를 바꾸면 지연 불변식 트리거가 COMMIT에 깨어나 classes·users·
-- teacher_profiles를 가로질러 읽는다. 호출자 권한으로 두면 그 읽기 목록이 바뀔
-- 때마다 운영자 권한을 따라 넓혀야 하고, 빠뜨리면 COMMIT에서 터진다(마이그 22000에서
-- 실제로 겪었다). 마이그 10000·22000이 형제 트리거에 쓴 처방을 그대로 적용한다.
ALTER FUNCTION enforce_class_member_invariants() SECURITY DEFINER;
ALTER FUNCTION enforce_class_member_invariants()
  SET search_path TO pg_catalog, public;
REVOKE EXECUTE ON FUNCTION enforce_class_member_invariants() FROM PUBLIC;

-- Down Migration

ALTER FUNCTION enforce_class_member_invariants() SECURITY INVOKER;
ALTER FUNCTION enforce_class_member_invariants() RESET search_path;
GRANT EXECUTE ON FUNCTION enforce_class_member_invariants() TO PUBLIC;

REVOKE USAGE ON SEQUENCE
  class_members_id_seq,
  class_member_status_history_id_seq
  FROM classhub_operator;
REVOKE INSERT (member_id, class_id, from_status, to_status, actor_operator_id, reason)
  ON class_member_status_history FROM classhub_operator;
REVOKE SELECT (id, class_id, user_id, role, status, row_version),
  INSERT (class_id, user_id, role, status),
  UPDATE (status, status_changed_at, updated_at, row_version)
  ON class_members FROM classhub_operator;
REVOKE SELECT (id, status) ON classes FROM classhub_operator;
