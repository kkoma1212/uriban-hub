-- S2 교사 자료함(P-024): 교사가 직접 고른 공지·준비물 글의 사본을 교사 계정에 둔다.
-- 반·학급 구성원과 외래키로 묶지 않는다 — 반이 보관·파기되거나 학교를 옮겨도 남는다.
-- 학생 기록(받는 학생·읽음·체크)은 옮기지 않고 글과 출처 표시(학년도·학교·학년·반 이름)만 둔다.
-- 담을 때 교사가 개인정보 확인을 마친 시각을 남긴다. 계정이 실제로 지워지면 함께 지운다.
CREATE TABLE teacher_library_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  owner_user_id BIGINT NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(100) NOT NULL,
  body TEXT,
  is_important BOOLEAN NOT NULL DEFAULT FALSE,
  source_item_id BIGINT,
  source_academic_year INT NOT NULL,
  source_grade INT NOT NULL,
  source_school_name VARCHAR(100) NOT NULL,
  source_class_name VARCHAR(40) NOT NULL,
  personal_info_confirmed_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT teacher_library_items_source_unique UNIQUE (owner_user_id, kind, source_item_id),
  CONSTRAINT teacher_library_items_owner_fk FOREIGN KEY (owner_user_id)
    REFERENCES users (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT teacher_library_items_kind_check CHECK (
    (BINARY kind = BINARY 'notice' AND BINARY category IN (BINARY 'general', BINARY 'performance'))
    OR (BINARY kind = BINARY 'supply' AND BINARY category IN (BINARY 'general', BINARY 'homework'))
  ),
  CONSTRAINT teacher_library_items_important_check CHECK (
    is_important = FALSE OR BINARY kind = BINARY 'notice'
  ),
  CONSTRAINT teacher_library_items_title_check CHECK (
    CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 100
  ),
  CONSTRAINT teacher_library_items_body_check CHECK (body IS NULL OR CHAR_LENGTH(body) <= 2000),
  CONSTRAINT teacher_library_items_source_check CHECK (
    source_academic_year BETWEEN 2020 AND 2100
    AND source_grade BETWEEN 1 AND 6
    AND CHAR_LENGTH(TRIM(source_school_name)) BETWEEN 1 AND 100
    AND CHAR_LENGTH(TRIM(source_class_name)) BETWEEN 1 AND 40
  ),
  INDEX teacher_library_items_owner_list_index (owner_user_id, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
