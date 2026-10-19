-- Up Migration

/*
 * suspended 학급의 담임 이관은 classes 재활성화와 멤버십 교체·감사를 같은
 * transaction에서 끝내야 한다(PRD_FINAL 5.2, 5.6). classhub_operator에 classes
 * UPDATE를 직접 주면 이관과 무관한 생명주기 metadata까지 바꿀 수 있으므로,
 * 이 전이에 필요한 네 필드와 row_version·updated_at만 소유자 권한 함수로 갱신한다.
 *
 * 호출 전 읽은 row_version을 요구하고 함수 안에서 row를 FOR UPDATE해, 읽기 뒤
 * 다른 생명주기 전이가 끼어든 경우 stale 요청으로 거부한다. classes의 지연 불변식
 * trigger는 transaction commit 시 active 학급의 유효한 approved 교사가 정확히
 * 한 명인지 다시 검증하므로, 함수만 단독 호출해 잘못된 active 상태를 commit할 수
 * 없다. CLI의 이후 멤버십 또는 감사 쓰기가 실패해도 이 UPDATE까지 함께 rollback된다.
 */
CREATE FUNCTION reactivate_suspended_class_for_teacher_transfer(
  p_class_id BIGINT,
  p_expected_row_version BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog
AS $function$
DECLARE
  current_status TEXT;
  current_row_version BIGINT;
  next_row_version BIGINT;
BEGIN
  IF p_class_id IS NULL OR p_expected_row_version IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'class id and expected row version are required';
  END IF;

  SELECT target.status, target.row_version
    INTO current_status, current_row_version
    FROM public.classes AS target
   WHERE target.id = p_class_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = format('class %s does not exist', p_class_id);
  END IF;

  IF current_status <> 'suspended' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format(
        'class %s must be suspended for teacher-transfer reactivation (status=%s)',
        p_class_id,
        current_status
      );
  END IF;

  IF current_row_version <> p_expected_row_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = format(
        'class %s row version changed (expected=%s, actual=%s)',
        p_class_id,
        p_expected_row_version,
        current_row_version
      );
  END IF;

  UPDATE public.classes AS target
     SET status = 'active',
         suspended_at = NULL,
         suspended_reason = NULL,
         suspended_by_operator_id = NULL,
         row_version = target.row_version + 1,
         updated_at = transaction_timestamp()
   WHERE target.id = p_class_id
     AND target.status = 'suspended'
     AND target.row_version = p_expected_row_version
  RETURNING target.row_version INTO next_row_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = format('class %s changed during teacher-transfer reactivation', p_class_id);
  END IF;

  RETURN next_row_version;
END
$function$;

REVOKE ALL ON FUNCTION reactivate_suspended_class_for_teacher_transfer(BIGINT, BIGINT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reactivate_suspended_class_for_teacher_transfer(BIGINT, BIGINT)
  TO classhub_operator;

-- row_version은 optimistic concurrency token으로만 읽으며, classes UPDATE는 열지 않는다.
GRANT SELECT (row_version) ON classes TO classhub_operator;

-- Down Migration

REVOKE SELECT (row_version) ON classes FROM classhub_operator;
REVOKE EXECUTE ON FUNCTION reactivate_suspended_class_for_teacher_transfer(BIGINT, BIGINT)
  FROM classhub_operator;
DROP FUNCTION reactivate_suspended_class_for_teacher_transfer(BIGINT, BIGINT);
