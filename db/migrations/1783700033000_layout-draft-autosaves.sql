-- Up Migration

/*
 * 왜 이 표가 필요한가 — T-HUB-31(자리·모둠 초안 임시저장).
 *
 * 자리 배치는 네 단계 마법사로 만든다(교실 배치 → 참여 학생 → 고정 자리 → 최종 확인).
 * 그런데 그동안 그 입력은 화면 메모리에만 있었다. 새로고침하거나 다른 화면으로 가면
 * 통째로 사라졌고, 초안을 만든 뒤에는 마법사로 돌아올 길조차 없었다. 교사가 자리를
 * 짜다가 잠깐 다른 일을 보면 처음부터 다시 해야 했다(2026-08-17 Hex 지적).
 *
 * 브라우저에 담는 값싼 길도 있었으나 Hex 가 **서버**를 택했다 — PC에서 짜다 폰에서
 * 이어서 하려는 것이다. 그래서 표로 만든다.
 *
 * ⚠️ 이건 "만들던 도중"만 담는다. 이미 만들어진 초안은 seat_draws·team_draws 에
 * 그대로 있고 이 표와 무관하다. 여기 담긴 것은 아직 자리표가 아니라 **작성 중인 설정**이다.
 */
CREATE TABLE layout_draft_autosaves (
  id BIGSERIAL PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  member_id BIGINT NOT NULL,
  /*
   * 자리와 모둠이 한 표를 함께 쓴다. 담는 것이 "만들던 설정 + 마지막 손댄 시각"뿐이라
   * 둘의 모양이 갈리지 않기 때문이다 — 서로 다른 부분은 전부 payload 안에 있다.
   * 표를 나누면 마이그레이션·API·삭제 장치가 전부 두 벌이 된다.
   */
  kind TEXT NOT NULL,
  /*
   * 마법사가 들고 있던 상태를 그대로 담는다. 스키마로 못박지 않는 이유는 마법사 단계가
   * 제품과 함께 바뀌기 때문이다 — 칸을 고정하면 화면을 고칠 때마다 마이그레이션이 붙는다.
   * 대신 **읽을 때 검증한다**(API 층). 모양이 안 맞는 임시저장은 버리고 새로 시작한다.
   */
  payload JSONB NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT layout_draft_autosaves_kind_check CHECK (kind IN ('seat_draw', 'team_draw')),
  CONSTRAINT layout_draft_autosaves_member_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
);

/*
 * 한 사람이 한 종류에 하나만 갖는다(2026-08-17 Hex 결정). 새로 시작하면 앞의 것을
 * 덮는다 — 목록을 보여주지 않기로 했으므로 여러 개가 쌓이면 갈 곳 없는 행이 된다.
 * UNIQUE 로 못박아 두면 API 가 실수로 두 개를 만들 수 없다.
 */
CREATE UNIQUE INDEX layout_draft_autosaves_owner_kind_unique
  ON layout_draft_autosaves (class_id, member_id, kind);

/*
 * 만료된 것을 지우는 잡이 이 순서로 훑는다. 마지막 손댄 시각이 기준이다 —
 * 만지면 다시 7일이라는 뜻이다(Hex 발화: "1주일 동안 수정하지 않고 1주일이 지나면").
 */
CREATE INDEX layout_draft_autosaves_updated_at_index
  ON layout_draft_autosaves (updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON layout_draft_autosaves TO classhub_app;
GRANT USAGE ON SEQUENCE layout_draft_autosaves_id_seq TO classhub_app;

-- Down Migration

DROP INDEX layout_draft_autosaves_updated_at_index;

DROP INDEX layout_draft_autosaves_owner_kind_unique;

DROP TABLE layout_draft_autosaves;
