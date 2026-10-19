-- T-HUB-64 MariaDB baseline phase 0009 (development only).
-- PostgreSQL source: 1783700015000_student-assessment-records.sql (Up only).
-- Apply only to an isolated synthetic QA database; runtime ACLs remain separate.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE student_assessment_records (
  id BIGINT NOT NULL AUTO_INCREMENT,
  owner_user_id BIGINT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
  academic_year INT,
  semester INT,
  assessment_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin,
  subject TEXT,
  title TEXT,
  assessment_date DATE,
  score_hundredths INT,
  max_score_hundredths INT,
  weight_basis_points INT,
  memo TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  recorded_at DATETIME(6),
  expires_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6) + INTERVAL 30 DAY),
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT student_assessment_records_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT student_assessment_records_status_check CHECK (
    BINARY status IN (BINARY 'draft', BINARY 'recorded')
  ),
  CONSTRAINT student_assessment_records_academic_year_check CHECK (
    academic_year IS NULL OR academic_year BETWEEN 2020 AND 2100
  ),
  CONSTRAINT student_assessment_records_semester_check CHECK (
    semester IS NULL OR semester IN (1, 2)
  ),
  CONSTRAINT student_assessment_records_type_check CHECK (
    assessment_type IS NULL
    OR BINARY assessment_type IN (BINARY 'performance', BINARY 'written')
  ),
  CONSTRAINT student_assessment_records_subject_check CHECK (
    subject IS NULL OR (
      BINARY subject = BINARY TRIM(subject)
      AND CHAR_LENGTH(subject) BETWEEN 1 AND 30
      AND subject NOT REGEXP '[[:cntrl:]]'
    )
  ),
  CONSTRAINT student_assessment_records_title_check CHECK (
    title IS NULL OR (
      BINARY title = BINARY TRIM(title)
      AND CHAR_LENGTH(title) BETWEEN 1 AND 100
      AND title NOT REGEXP '[[:cntrl:]]'
    )
  ),
  CONSTRAINT student_assessment_records_date_check CHECK (
    academic_year IS NULL OR assessment_date IS NULL OR (
      assessment_date >= MAKEDATE(academic_year, 1) + INTERVAL 2 MONTH
      AND assessment_date < MAKEDATE(academic_year + 1, 1) + INTERVAL 2 MONTH
    )
  ),
  CONSTRAINT student_assessment_records_score_check CHECK (
    (score_hundredths IS NULL OR score_hundredths BETWEEN 0 AND 100000)
    AND (max_score_hundredths IS NULL OR max_score_hundredths BETWEEN 1 AND 100000)
    AND (
      score_hundredths IS NULL OR max_score_hundredths IS NULL
      OR score_hundredths <= max_score_hundredths
    )
  ),
  CONSTRAINT student_assessment_records_weight_check CHECK (
    weight_basis_points IS NULL OR weight_basis_points BETWEEN 1 AND 10000
  ),
  CONSTRAINT student_assessment_records_memo_check CHECK (
    memo IS NULL OR CHAR_LENGTH(memo) BETWEEN 1 AND 500
  ),
  CONSTRAINT student_assessment_records_row_version_check CHECK (row_version >= 1),
  CONSTRAINT student_assessment_records_time_check CHECK (
    created_at <= updated_at AND expires_at > created_at
  ),
  CONSTRAINT student_assessment_records_completion_check CHECK (
    (BINARY status = BINARY 'draft' AND recorded_at IS NULL)
    OR (
      BINARY status = BINARY 'recorded'
      AND academic_year IS NOT NULL
      AND semester IS NOT NULL
      AND assessment_type IS NOT NULL
      AND subject IS NOT NULL
      AND title IS NOT NULL
      AND assessment_date IS NOT NULL
      AND score_hundredths IS NOT NULL
      AND max_score_hundredths IS NOT NULL
      AND recorded_at IS NOT NULL
      AND expires_at = recorded_at + INTERVAL 365 DAY
    )
  ),
  -- MariaDB DESC already puts NULL last; explicit NULLS LAST syntax is not supported.
  INDEX student_assessment_records_owner_list_index (
    owner_user_id, status, academic_year DESC, semester DESC, assessment_date DESC, id DESC
  ),
  INDEX student_assessment_records_expiry_index (expires_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
