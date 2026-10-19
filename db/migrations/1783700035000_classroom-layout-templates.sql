-- Up Migration

/*
 * 왜 이 표가 필요한가 — 교실 배치 템플릿(2026-08-21 Hex 결정: 브라우저가 아니라 계정).
 *
 * 자리 만들기 1단계에서 교사는 매번 행·열을 찍고 못 쓰는 자리를 골라낸다. 그런데 그
 * 교실의 책상 배치는 한 학기 내내 거의 그대로다 — 바뀌는 것은 학생 명단과 고정 자리다.
 * 같은 배치를 매번 다시 찍게 하는 것이 낭비라 이름 붙여 저장해 두고 불러 쓴다.
 *
 * **임시저장(layout_draft_autosaves)에 얹지 않는 이유**: 그 표는
 * `UNIQUE (class_id, member_id, kind)` 로 **한 사람이 한 종류에 하나만** 갖도록
 * 못박혀 있고, 담는 것이 "만들던 도중"이라고 그 파일에 명시돼 있다. 템플릿은 이름을
 * 붙여 **여럿** 두는 것이라 그 계약과 정면으로 어긋난다.
 *
 * **담지 않는 것**: 학생 명단·제외 명단·고정 자리. 반이 바뀌면 무의미하고, 그건 이미
 * 임시저장이 하는 일이다. 여기 담는 것은 **교실의 책상 배치**뿐이다.
 */
CREATE TABLE classroom_layout_templates (
  id BIGSERIAL PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  member_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  /*
   * 배치 내용을 그대로 담는다. 스키마로 못박지 않는 이유는 임시저장과 같다 — 마법사
   * 1단계 구성이 제품과 함께 바뀌는데 칸을 고정하면 화면을 고칠 때마다 마이그레이션이
   * 붙는다. 대신 **읽을 때 검증한다**(API 층). 모양이 안 맞는 템플릿은 불러오지 않는다.
   */
  payload JSONB NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT classroom_layout_templates_member_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  /*
   * 이름 규칙은 이 저장소의 다른 사람이 붙이는 이름(자리표 제목·모둠표 제목)과 같은
   * 모양으로 맞춘다 — 앞뒤 공백 없음, 제어문자 없음. 길이만 40자로 짧다(목록에서
   * 한 줄에 보여야 하고, 자리표 제목처럼 날짜를 담는 이름이 아니다).
   */
  CONSTRAINT classroom_layout_templates_name_check CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 40
    AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT classroom_layout_templates_row_version_check CHECK (row_version >= 1)
);

/*
 * 같은 이름을 두 번 저장하면 덮어쓴다(목록에 같은 이름이 둘 있으면 어느 것을 부를지
 * 사람이 알 수 없다). UNIQUE 로 못박아 두면 API 가 실수로 두 개를 만들 수 없다.
 */
CREATE UNIQUE INDEX classroom_layout_templates_owner_name_unique
  ON classroom_layout_templates (class_id, member_id, name);

/* 목록은 "마지막에 손댄 것부터" 보여준다 — 방금 쓴 배치가 맨 위에 오게. */
CREATE INDEX classroom_layout_templates_owner_updated_at_index
  ON classroom_layout_templates (class_id, member_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON classroom_layout_templates TO classhub_app;
GRANT USAGE ON SEQUENCE classroom_layout_templates_id_seq TO classhub_app;

-- Down Migration

DROP TABLE classroom_layout_templates;
