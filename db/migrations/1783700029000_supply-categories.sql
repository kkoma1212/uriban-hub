-- Up Migration

/*
 * 숙제 배부(T-HUB-17 1단계).
 *
 * 숙제를 새 기능으로 만들지 않고 준비물의 한 종류로 둔다. 별도 기능으로 하면
 * supplies 의 15개 파일 구조를 한 벌 더 복제해야 하는데, 정작 필요한 것(확인 현황·
 * 재알림·커서 페이지네이션)은 전부 이미 supplies 에 붙어 있다. 실측으로 확인했다 —
 * supply_checks 와 in_app_reminders 는 supply_id 만 보고 종류를 보지 않는다.
 * 그래서 이 컬럼 하나면 숙제가 그 셋을 그대로 물려받는다.
 *
 * ⚠️ BACKLOG 가 경고한 "CHECK 목록을 통째로 다시 쓰면 남이 더한 값이 사라진다"
 * (T-HUB-02·T-HUB-10 이 두 번 덴 자리)는 여기엔 해당되지 않는다. 실측 결과
 * supplies 에는 종류 컬럼도 CHECK 목록도 아예 없었다 — 다시 쓸 목록이 없으므로
 * 그 사고가 재현될 자리가 없다. 새 컬럼을 더하는 일이다.
 *
 * 값 이름은 notices.category 의 관습을 그대로 따랐다('general' + 특수 종류).
 * 새 이름을 발명하면 두 표를 오갈 때마다 어느 쪽 관습인지 되짚어야 한다.
 *
 * category 는 audience_mode 와 달리 나중에 고칠 수 있게 둔다. audience_mode 가
 * 불변인 이유는 게시 시점에 받는 사람을 고정했기 때문인데, 종류에는 그런 결속이
 * 없다. 준비물로 잘못 올린 것을 숙제로 고치는 일은 흔한 교정이다.
 *
 * 목록 인덱스는 손대지 않는다. supplies_list_index (class_id, needed_on, id) 가
 * 정렬을 그대로 주고 종류는 걸러내기만 하면 되는데, 한 학급의 1년치가 수백 행
 * 수준이라 지금 인덱스를 늘릴 측정 근거가 없다. 느려지는 것이 보이면 그때 잰다.
 */

ALTER TABLE supplies
  ADD COLUMN category TEXT NOT NULL DEFAULT 'general',
  ADD CONSTRAINT supplies_category_check CHECK (category IN ('general', 'homework'));

-- Down Migration

/*
 * 되돌리기는 숙제 행이 하나도 없을 때만 허용한다. 컬럼을 그냥 떨어뜨리면 숙제였던
 * 행이 조용히 준비물이 되는데, 그건 되돌리기가 아니라 뜻을 잃는 것이다. 막힌 채로
 * 실패하는 편이 낫다 — 무엇을 지우게 되는지 사람이 보고 정하게 된다.
 */
DO $supply_categories_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM supplies WHERE category <> 'general') THEN
    RAISE EXCEPTION
      'supply category rollback requires every supply row to be category = general';
  END IF;
END;
$supply_categories_rollback_guard$;

ALTER TABLE supplies
  DROP CONSTRAINT supplies_category_check,
  DROP COLUMN category;
