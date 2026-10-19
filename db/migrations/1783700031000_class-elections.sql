-- Up Migration

/*
 * 왜 이 표들이 있나 — T-HUB-18 반장·학급 대표 선거.
 *
 * 기존 투표(polls)에 얹을 수 없다. `poll_votes`는 `member_id`와 `option_id`를
 * 항상 함께 저장하고 `UNIQUE (poll_id, member_id)`가 걸려 있어, 누가 누구를
 * 뽑았는지가 언제나 남는다. `ballot_visibility='private'`는 "교사 화면에 안
 * 보임"이지 "기록을 안 남김"이 아니다. 선거에서 이건 곁가지가 아니라 기능의
 * 핵심이 무너지는 문제다 — 학생이 "선생님은 내가 누구를 안 뽑았는지 안다"를
 * 알면 솔직하게 찍지 않는다.
 *
 * 그래서 저장 경로를 새로 만든다. 설계의 핵심은 **표 한 장당 행을 만들지
 * 않는 것**이다:
 *   - `election_tallies`   : 후보별 득표 "수"만 센다.
 *   - `election_participants`: "이 학생은 투표했다"만 남기고 무엇을 골랐는지는
 *                              어디에도 두지 않는다. 중복 투표는 PK가 막는다.
 *
 * 표 한 장당 행이 있으면 그 행의 순번이나 시각을 참여 기록과 짝지어 역추적할
 * 수 있다. 행 자체를 만들지 않으면 짝지을 대상이 없다. 같은 이유로 이 두 표에는
 * **타임스탬프를 두지 않는다** — 시간 상관이 곧 역추적 수단이기 때문이다.
 *
 * ⚠️ 완벽하지 않다(정직 표기). 득표 수 증가와 참여 기록을 한 트랜잭션으로 묶으면
 * 두 행의 `xmin`이 같아져, DB에 직접 접근할 수 있는 사람은 **가장 최근 투표자
 * 한 명**을 역추적할 수 있다(2026-08-11 실측). 나누면 그 문제는 사라지지만 중간에
 * 죽었을 때 표가 새거나 이중 투표가 생긴다. 이 프로젝트의 위협 모델은 "교사가 앱
 * 에서 볼 수 없을 것"이고 DB 접근자는 개발자 본인뿐이라, 신뢰성을 택했다.
 */
CREATE TABLE elections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  /*
   * 동표 처리 방식은 개표 전에 정해져 있어야 한다 — 결과를 보고 방식을 고르면
   * 그건 선거가 아니다. 아래 트리거가 생성 후 변경을 막는다.
   */
  tie_break TEXT NOT NULL,
  results_visibility TEXT NOT NULL,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT elections_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT elections_status_check CHECK (status IN ('draft', 'open', 'closed', 'published')),
  CONSTRAINT elections_tie_break_check
    CHECK (tie_break IN ('revote', 'elder', 'teacher_decides')),
  CONSTRAINT elections_results_visibility_check
    CHECK (results_visibility IN ('winner_only', 'with_counts')),
  CONSTRAINT elections_creator_class_foreign_key FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

CREATE TABLE election_candidates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  election_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  -- 이름을 나중에 고쳐도 그때의 개표 결과가 흔들리면 안 된다(당번 배정과 같은 이유).
  display_name_snapshot TEXT NOT NULL,
  student_number_snapshot INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT election_candidates_id_election_unique UNIQUE (id, election_id),
  CONSTRAINT election_candidates_election_member_unique UNIQUE (election_id, member_id),
  CONSTRAINT election_candidates_election_class_foreign_key FOREIGN KEY (election_id, class_id)
    REFERENCES elections (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT election_candidates_member_class_foreign_key FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

/*
 * 득표 "수"만 센다. 표 한 장당 행이 없으므로 순번·시각으로 역추적할 대상이 없다.
 * 그 대가로 재검표는 불가능하다 — 2026-08-11 Hex 결정: 학급 선거에서는 재검표보다
 * 익명이 중요하다.
 */
CREATE TABLE election_tallies (
  election_id BIGINT NOT NULL,
  candidate_id BIGINT NOT NULL,
  vote_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT election_tallies_pkey PRIMARY KEY (election_id, candidate_id),
  CONSTRAINT election_tallies_vote_count_check CHECK (vote_count >= 0),
  CONSTRAINT election_tallies_candidate_election_foreign_key FOREIGN KEY (candidate_id, election_id)
    REFERENCES election_candidates (id, election_id) ON DELETE RESTRICT
);

/*
 * "투표했다"만 남긴다. 무엇을 골랐는지는 이 표에도, 다른 어디에도 없다.
 * 타임스탬프를 일부러 두지 않는다 — 있으면 득표 수가 오른 순서와 맞춰 볼 수 있다.
 */
CREATE TABLE election_participants (
  election_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  CONSTRAINT election_participants_pkey PRIMARY KEY (election_id, member_id),
  CONSTRAINT election_participants_election_class_foreign_key FOREIGN KEY (election_id, class_id)
    REFERENCES elections (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT election_participants_member_class_foreign_key FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

CREATE FUNCTION enforce_election_tie_break_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tie_break IS DISTINCT FROM OLD.tie_break THEN
    RAISE EXCEPTION 'election tie break rule cannot change after the election is created';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER elections_tie_break_immutable
  BEFORE UPDATE ON elections
  FOR EACH ROW EXECUTE FUNCTION enforce_election_tie_break_immutable();

/*
 * 감사는 "누가 선거를 만들고 개표했나"만 남긴다(2026-08-11 Hex 결정).
 * 개별 투표는 절대 남기지 않는다 — 그걸 남기면 이 설계 전체가 무의미해진다.
 *
 * action 추가가 INSERT 한 줄이 된 것은 T-HUB-21 덕분이다. 그리고 이 행들은
 * JSON 스냅샷을 싣지 않으므로(`jsonb_has_only_keys`는 NULL에 TRUE를 준다)
 * 허용목록 CHECK를 다시 쓸 필요가 없다. 누가·무엇을·언제는 별도 칼럼에 남는다.
 */
INSERT INTO audit_log_actions (action) VALUES
  ('election.created'),
  ('election.candidate_registered'),
  ('election.opened'),
  ('election.closed'),
  ('election.published');

GRANT SELECT, INSERT, UPDATE, DELETE ON elections TO classhub_app;
GRANT SELECT, INSERT, DELETE ON election_candidates TO classhub_app;
GRANT SELECT, INSERT, UPDATE ON election_tallies TO classhub_app;
-- 참여 기록은 지울 수 없다. 지울 수 있으면 다시 투표하게 만들 수 있다.
GRANT SELECT, INSERT ON election_participants TO classhub_app;
GRANT USAGE ON SEQUENCE elections_id_seq, election_candidates_id_seq TO classhub_app;

-- Down Migration

DO $class_elections_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM election_participants) THEN
    RAISE EXCEPTION
      'election rollback requires participation records to be empty — votes cannot be recovered';
  END IF;

  IF EXISTS (SELECT 1 FROM audit_logs WHERE action LIKE 'election.%') THEN
    RAISE EXCEPTION 'election rollback requires election audit rows to be empty';
  END IF;
END
$class_elections_rollback_guard$;

DELETE FROM audit_log_actions WHERE action LIKE 'election.%';

DROP TRIGGER elections_tie_break_immutable ON elections;

DROP FUNCTION enforce_election_tie_break_immutable();

DROP TABLE election_participants;

DROP TABLE election_tallies;

DROP TABLE election_candidates;

DROP TABLE elections;
