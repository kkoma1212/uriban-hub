-- Up Migration

CREATE TABLE notices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_important BOOLEAN NOT NULL DEFAULT FALSE,
  content_revision BIGINT NOT NULL DEFAULT 1,
  row_version BIGINT NOT NULL DEFAULT 1,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_member_id BIGINT NOT NULL,
  updated_by_member_id BIGINT,
  deleted_at TIMESTAMPTZ,
  deleted_by_member_id BIGINT,
  delete_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notices_id_class_unique UNIQUE (id, class_id),
  FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (deleted_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notices_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  CONSTRAINT notices_content_check CHECK (char_length(btrim(content)) BETWEEN 1 AND 2000),
  CONSTRAINT notices_revision_check CHECK (content_revision >= 1 AND row_version >= 1),
  CONSTRAINT notices_delete_state_check CHECK (
    (deleted_at IS NULL AND deleted_by_member_id IS NULL AND delete_reason IS NULL)
    OR
    (
      deleted_at IS NOT NULL AND deleted_by_member_id IS NOT NULL
      AND (delete_reason IS NULL OR char_length(delete_reason) <= 300)
    )
  )
);

CREATE INDEX notices_list_index
  ON notices (class_id, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX notices_importance_index
  ON notices (class_id, is_important, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE notice_reads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  notice_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  first_confirmed_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  confirmed_revision BIGINT NOT NULL,
  CONSTRAINT notice_reads_notice_member_unique UNIQUE (notice_id, member_id),
  FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notice_reads_time_check CHECK (first_confirmed_at <= confirmed_at),
  CONSTRAINT notice_reads_revision_check CHECK (confirmed_revision >= 1)
);

CREATE TABLE supplies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  needed_on DATE NOT NULL,
  content_revision BIGINT NOT NULL DEFAULT 1,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_member_id BIGINT NOT NULL,
  updated_by_member_id BIGINT,
  deleted_at TIMESTAMPTZ,
  deleted_by_member_id BIGINT,
  delete_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplies_id_class_unique UNIQUE (id, class_id),
  FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (deleted_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supplies_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  CONSTRAINT supplies_description_check CHECK (
    description IS NULL OR char_length(description) <= 500
  ),
  CONSTRAINT supplies_revision_check CHECK (content_revision >= 1 AND row_version >= 1),
  CONSTRAINT supplies_delete_state_check CHECK (
    (deleted_at IS NULL AND deleted_by_member_id IS NULL AND delete_reason IS NULL)
    OR
    (
      deleted_at IS NOT NULL AND deleted_by_member_id IS NOT NULL
      AND (delete_reason IS NULL OR char_length(delete_reason) <= 300)
    )
  )
);

CREATE INDEX supplies_list_index
  ON supplies (class_id, needed_on, id)
  WHERE deleted_at IS NULL;

CREATE TABLE supply_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL,
  supply_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  is_checked BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ,
  unchecked_at TIMESTAMPTZ,
  confirmed_revision BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supply_checks_supply_member_unique UNIQUE (supply_id, member_id),
  FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supply_checks_state_check CHECK (
    (
      is_checked
      AND checked_at IS NOT NULL
      AND unchecked_at IS NULL
      AND confirmed_revision IS NOT NULL
      AND confirmed_revision >= 1
    )
    OR
    (
      NOT is_checked
      AND checked_at IS NULL
      AND unchecked_at IS NOT NULL
      AND confirmed_revision IS NULL
    )
  )
);

CREATE TABLE schedules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  subject TEXT,
  schedule_type TEXT NOT NULL,
  due_date DATE NOT NULL,
  description TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_member_id BIGINT NOT NULL,
  updated_by_member_id BIGINT,
  deleted_at TIMESTAMPTZ,
  deleted_by_member_id BIGINT,
  delete_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedules_id_class_unique UNIQUE (id, class_id),
  FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (deleted_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT schedules_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  CONSTRAINT schedules_subject_check CHECK (subject IS NULL OR char_length(subject) <= 30),
  CONSTRAINT schedules_description_check CHECK (
    description IS NULL OR char_length(description) <= 500
  ),
  CONSTRAINT schedules_type_check CHECK (
    schedule_type IN ('exam', 'performance', 'assignment', 'other')
  ),
  CONSTRAINT schedules_row_version_check CHECK (row_version >= 1),
  CONSTRAINT schedules_delete_state_check CHECK (
    (deleted_at IS NULL AND deleted_by_member_id IS NULL AND delete_reason IS NULL)
    OR
    (
      deleted_at IS NOT NULL AND deleted_by_member_id IS NOT NULL
      AND (delete_reason IS NULL OR char_length(delete_reason) <= 300)
    )
  )
);

CREATE INDEX schedules_list_index
  ON schedules (class_id, due_date, id)
  WHERE deleted_at IS NULL;

CREATE TABLE meals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  edu_office_code TEXT NOT NULL,
  school_code TEXT NOT NULL,
  meal_date DATE NOT NULL,
  meal_type TEXT NOT NULL,
  menu_json JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  source_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (edu_office_code, school_code)
    REFERENCES schools (edu_office_code, school_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meals_school_date_type_unique UNIQUE (
    edu_office_code, school_code, meal_date, meal_type
  ),
  CONSTRAINT meals_type_check CHECK (meal_type IN ('breakfast', 'lunch', 'dinner')),
  CONSTRAINT meals_source_check CHECK (source = 'seed'),
  CONSTRAINT meals_menu_array_check CHECK (
    jsonb_typeof(menu_json) = 'array'
    AND jsonb_array_length(menu_json) BETWEEN 1 AND 50
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON notices, notice_reads, supplies, supply_checks, schedules
  TO classhub_app;
GRANT SELECT ON meals TO classhub_app;

-- Down Migration

DROP TABLE meals;
DROP TABLE schedules;
DROP TABLE supply_checks;
DROP TABLE supplies;
DROP TABLE notice_reads;
DROP TABLE notices;
