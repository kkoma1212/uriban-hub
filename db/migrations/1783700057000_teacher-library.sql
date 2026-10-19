-- Up Migration
-- S2 교사 자료함(P-024): 교사가 직접 고른 공지·준비물 글의 사본을 교사 계정에 둔다.
-- 반·학급 구성원과 외래키로 묶지 않는다 — 반이 보관·파기되거나 학교를 옮겨도 남는다.
-- 학생 기록(받는 학생·읽음·체크)은 옮기지 않고 글과 출처 표시(학년도·학교·학년·반 이름)만 둔다.
-- 담을 때 교사가 개인정보 확인을 마친 시각을 남긴다. 계정이 실제로 지워지면 함께 지운다.
CREATE TABLE teacher_library_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  is_important BOOLEAN NOT NULL DEFAULT FALSE,
  source_item_id BIGINT,
  source_academic_year INTEGER NOT NULL,
  source_grade INTEGER NOT NULL,
  source_school_name TEXT NOT NULL,
  source_class_name TEXT NOT NULL,
  personal_info_confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT teacher_library_items_source_unique UNIQUE (owner_user_id, kind, source_item_id),
  CONSTRAINT teacher_library_items_kind_check CHECK (
    (kind = 'notice' AND category IN ('general', 'performance'))
    OR (kind = 'supply' AND category IN ('general', 'homework'))
  ),
  CONSTRAINT teacher_library_items_important_check CHECK (is_important = FALSE OR kind = 'notice'),
  CONSTRAINT teacher_library_items_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  CONSTRAINT teacher_library_items_body_check CHECK (body IS NULL OR char_length(body) <= 2000),
  CONSTRAINT teacher_library_items_source_check CHECK (
    source_academic_year BETWEEN 2020 AND 2100
    AND source_grade BETWEEN 1 AND 6
    AND char_length(btrim(source_school_name)) BETWEEN 1 AND 100
    AND char_length(btrim(source_class_name)) BETWEEN 1 AND 40
  )
);
CREATE INDEX teacher_library_items_owner_list_index
  ON teacher_library_items (owner_user_id, created_at DESC, id DESC);

REVOKE ALL ON teacher_library_items FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON teacher_library_items TO classhub_app;

-- Down Migration
-- 교사가 담은 글에는 학생 이름이 섞였을 수 있어 되돌릴 때 함께 지운다.
REVOKE ALL ON teacher_library_items FROM classhub_app;
DROP TABLE teacher_library_items;
