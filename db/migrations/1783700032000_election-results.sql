-- Up Migration

/*
 * 왜 이 칸들이 필요한가 — T-HUB-18 2-c(개표·발표).
 *
 * 당선자는 대부분 득표 수에서 바로 나오지만, **동점이면 계산으로 나오지 않는다.**
 * 동표 처리 방식이 정한 절차를 거쳐 사람이 고른 결과라서, 그 결정을 어딘가 남겨야
 * 다시 열어도 같은 답이 나온다.
 *
 * ⚠️ "연장자" 방식에 필요한 생년월일은 이 제품 어디에도 없다(2026-08-11 실측).
 * 아이들 생년월일을 새로 모으는 것은 개인정보 범위를 늘리는 일이라 하지 않는다.
 * 대신 연장자 방식도 **교사가 동점자 중에서 고르는 것**으로 구현하고, 무엇을 근거로
 * 골랐는지를 `tie_break_applied`로 남긴다 — 묻는 문구와 기록되는 사유가 다르므로
 * "교사 재량"과 구분된다. 학생이 받아들이는 정당성이 다르기 때문에 구분할 값어치가
 * 있다.
 */
ALTER TABLE elections
  ADD COLUMN winner_candidate_id BIGINT,
  ADD COLUMN tie_break_applied BOOLEAN NOT NULL DEFAULT FALSE;

/*
 * 당선자는 반드시 그 선거의 후보여야 한다. 복합 외래키로 못박는다 — 다른 선거의
 * 후보가 당선자로 들어가는 일이 스키마 수준에서 불가능해진다.
 */
ALTER TABLE elections
  ADD CONSTRAINT elections_winner_candidate_foreign_key
  FOREIGN KEY (winner_candidate_id, id) REFERENCES election_candidates (id, election_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

/* 발표된 선거에 당선자가 없으면 그건 발표가 아니다. */
ALTER TABLE elections
  ADD CONSTRAINT elections_published_requires_winner_check
  CHECK (status <> 'published' OR winner_candidate_id IS NOT NULL);

-- Down Migration

DO $election_results_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM elections WHERE winner_candidate_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'election results rollback requires published winners to be empty — the decision cannot be recovered';
  END IF;
END
$election_results_rollback_guard$;

ALTER TABLE elections
  DROP CONSTRAINT elections_published_requires_winner_check;

ALTER TABLE elections
  DROP CONSTRAINT elections_winner_candidate_foreign_key;

ALTER TABLE elections
  DROP COLUMN tie_break_applied,
  DROP COLUMN winner_candidate_id;
