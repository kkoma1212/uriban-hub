-- Up Migration

CREATE TABLE student_assessment_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  academic_year INTEGER,
  semester INTEGER,
  assessment_type TEXT,
  subject TEXT,
  title TEXT,
  assessment_date DATE,
  score_hundredths INTEGER,
  max_score_hundredths INTEGER,
  weight_basis_points INTEGER,
  memo TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  recorded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT student_assessment_records_status_check CHECK (
    status IN ('draft', 'recorded')
  ),
  CONSTRAINT student_assessment_records_academic_year_check CHECK (
    academic_year IS NULL OR academic_year BETWEEN 2020 AND 2100
  ),
  CONSTRAINT student_assessment_records_semester_check CHECK (
    semester IS NULL OR semester IN (1, 2)
  ),
  CONSTRAINT student_assessment_records_type_check CHECK (
    assessment_type IS NULL OR assessment_type IN ('performance', 'written')
  ),
  CONSTRAINT student_assessment_records_subject_check CHECK (
    subject IS NULL
    OR (
      subject = btrim(subject)
      AND char_length(subject) BETWEEN 1 AND 30
      AND subject !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT student_assessment_records_title_check CHECK (
    title IS NULL
    OR (
      title = btrim(title)
      AND char_length(title) BETWEEN 1 AND 100
      AND title !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT student_assessment_records_date_check CHECK (
    academic_year IS NULL
    OR assessment_date IS NULL
    OR (
      assessment_date >= make_date(academic_year, 3, 1)
      AND assessment_date < make_date(academic_year + 1, 3, 1)
    )
  ),
  CONSTRAINT student_assessment_records_score_check CHECK (
    (score_hundredths IS NULL OR score_hundredths BETWEEN 0 AND 100000)
    AND (max_score_hundredths IS NULL OR max_score_hundredths BETWEEN 1 AND 100000)
    AND (
      score_hundredths IS NULL
      OR max_score_hundredths IS NULL
      OR score_hundredths <= max_score_hundredths
    )
  ),
  CONSTRAINT student_assessment_records_weight_check CHECK (
    weight_basis_points IS NULL OR weight_basis_points BETWEEN 1 AND 10000
  ),
  CONSTRAINT student_assessment_records_memo_check CHECK (
    memo IS NULL OR char_length(memo) BETWEEN 1 AND 500
  ),
  CONSTRAINT student_assessment_records_row_version_check CHECK (row_version >= 1),
  CONSTRAINT student_assessment_records_time_check CHECK (
    created_at <= updated_at AND expires_at > created_at
  ),
  CONSTRAINT student_assessment_records_completion_check CHECK (
    (
      status = 'draft'
      AND recorded_at IS NULL
    )
    OR
    (
      status = 'recorded'
      AND academic_year IS NOT NULL
      AND semester IS NOT NULL
      AND assessment_type IS NOT NULL
      AND subject IS NOT NULL
      AND title IS NOT NULL
      AND assessment_date IS NOT NULL
      AND score_hundredths IS NOT NULL
      AND max_score_hundredths IS NOT NULL
      AND recorded_at IS NOT NULL
      AND expires_at = recorded_at + interval '365 days'
    )
  )
);

CREATE INDEX student_assessment_records_owner_list_index
  ON student_assessment_records (
    owner_user_id,
    status,
    academic_year DESC NULLS LAST,
    semester DESC NULLS LAST,
    assessment_date DESC NULLS LAST,
    id DESC
  );

CREATE INDEX student_assessment_records_expiry_index
  ON student_assessment_records (expires_at, id);

REVOKE ALL PRIVILEGES ON student_assessment_records FROM PUBLIC;
REVOKE ALL PRIVILEGES ON student_assessment_records_id_seq FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON student_assessment_records TO classhub_app;
GRANT USAGE ON SEQUENCE student_assessment_records_id_seq TO classhub_app;
GRANT SELECT, DELETE ON student_assessment_records TO classhub_retention;

-- Down Migration

DO $student_assessment_records_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM student_assessment_records) THEN
    RAISE EXCEPTION
      'student assessment rollback requires student_assessment_records to be empty';
  END IF;
END
$student_assessment_records_rollback_guard$;

REVOKE ALL PRIVILEGES ON student_assessment_records FROM classhub_app, classhub_retention;
REVOKE ALL PRIVILEGES ON student_assessment_records_id_seq FROM classhub_app;

DROP TABLE student_assessment_records;
