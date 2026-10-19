-- T-HUB-64 MariaDB baseline phase 0003 (development only).
-- Provisional target: MariaDB 11.4 LTS. Apply only to an isolated synthetic QA database.
-- PostgreSQL sources:
--   1783700002000_content-meals.sql
--   1783700011000_neis-meal-source.sql
--   1783700012000_neis-meal-calorie.sql
--   1783700029000_supply-categories.sql
-- This file creates schema only. Runtime grants and traffic activation stay outside this phase.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE notices (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_important BOOLEAN NOT NULL DEFAULT FALSE,
  content_revision BIGINT NOT NULL DEFAULT 1,
  row_version BIGINT NOT NULL DEFAULT 1,
  published_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  created_by_member_id BIGINT NOT NULL,
  updated_by_member_id BIGINT,
  deleted_at DATETIME(6),
  deleted_by_member_id BIGINT,
  delete_reason TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT notices_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT notices_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT notices_created_by_member_fk
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notices_updated_by_member_fk
    FOREIGN KEY (updated_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notices_deleted_by_member_fk
    FOREIGN KEY (deleted_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notices_is_important_check CHECK (is_important IN (FALSE, TRUE)),
  CONSTRAINT notices_title_check CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 100),
  CONSTRAINT notices_content_check CHECK (CHAR_LENGTH(TRIM(content)) BETWEEN 1 AND 2000),
  CONSTRAINT notices_revision_check CHECK (content_revision >= 1 AND row_version >= 1),
  CONSTRAINT notices_delete_state_check CHECK (
    (deleted_at IS NULL AND deleted_by_member_id IS NULL AND delete_reason IS NULL)
    OR
    (
      deleted_at IS NOT NULL
      AND deleted_by_member_id IS NOT NULL
      AND (delete_reason IS NULL OR CHAR_LENGTH(delete_reason) <= 300)
    )
  ),
  INDEX notices_list_index (class_id, deleted_at, published_at DESC, id DESC),
  INDEX notices_importance_index (
    class_id, deleted_at, is_important, published_at DESC, id DESC
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE notice_reads (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  notice_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  first_confirmed_at DATETIME(6) NOT NULL,
  confirmed_at DATETIME(6) NOT NULL,
  confirmed_revision BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT notice_reads_notice_member_unique UNIQUE (notice_id, member_id),
  CONSTRAINT notice_reads_notice_fk
    FOREIGN KEY (notice_id, class_id)
    REFERENCES notices (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notice_reads_member_fk
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT notice_reads_time_check CHECK (first_confirmed_at <= confirmed_at),
  CONSTRAINT notice_reads_revision_check CHECK (confirmed_revision >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE supplies (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  needed_on DATE NOT NULL,
  category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'general',
  content_revision BIGINT NOT NULL DEFAULT 1,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_member_id BIGINT NOT NULL,
  updated_by_member_id BIGINT,
  deleted_at DATETIME(6),
  deleted_by_member_id BIGINT,
  delete_reason TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT supplies_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT supplies_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT supplies_created_by_member_fk
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supplies_updated_by_member_fk
    FOREIGN KEY (updated_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supplies_deleted_by_member_fk
    FOREIGN KEY (deleted_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supplies_title_check CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 100),
  CONSTRAINT supplies_description_check CHECK (
    description IS NULL OR CHAR_LENGTH(description) <= 500
  ),
  CONSTRAINT supplies_category_check CHECK (BINARY category IN (BINARY 'general', BINARY 'homework')),
  CONSTRAINT supplies_revision_check CHECK (content_revision >= 1 AND row_version >= 1),
  CONSTRAINT supplies_delete_state_check CHECK (
    (deleted_at IS NULL AND deleted_by_member_id IS NULL AND delete_reason IS NULL)
    OR
    (
      deleted_at IS NOT NULL
      AND deleted_by_member_id IS NOT NULL
      AND (delete_reason IS NULL OR CHAR_LENGTH(delete_reason) <= 300)
    )
  ),
  INDEX supplies_list_index (class_id, deleted_at, needed_on, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE supply_checks (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  supply_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  is_checked BOOLEAN NOT NULL,
  checked_at DATETIME(6),
  unchecked_at DATETIME(6),
  confirmed_revision BIGINT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT supply_checks_supply_member_unique UNIQUE (supply_id, member_id),
  CONSTRAINT supply_checks_supply_fk
    FOREIGN KEY (supply_id, class_id)
    REFERENCES supplies (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supply_checks_member_fk
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT supply_checks_is_checked_check CHECK (is_checked IN (FALSE, TRUE)),
  CONSTRAINT supply_checks_state_check CHECK (
    (
      is_checked = TRUE
      AND checked_at IS NOT NULL
      AND unchecked_at IS NULL
      AND confirmed_revision IS NOT NULL
      AND confirmed_revision >= 1
    )
    OR
    (
      is_checked = FALSE
      AND checked_at IS NULL
      AND unchecked_at IS NOT NULL
      AND confirmed_revision IS NULL
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE schedules (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT,
  schedule_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  due_date DATE NOT NULL,
  description TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_member_id BIGINT NOT NULL,
  updated_by_member_id BIGINT,
  deleted_at DATETIME(6),
  deleted_by_member_id BIGINT,
  delete_reason TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT schedules_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT schedules_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT schedules_created_by_member_fk
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT schedules_updated_by_member_fk
    FOREIGN KEY (updated_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT schedules_deleted_by_member_fk
    FOREIGN KEY (deleted_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT schedules_title_check CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 1 AND 100),
  CONSTRAINT schedules_subject_check CHECK (subject IS NULL OR CHAR_LENGTH(subject) <= 30),
  CONSTRAINT schedules_description_check CHECK (
    description IS NULL OR CHAR_LENGTH(description) <= 500
  ),
  CONSTRAINT schedules_type_check CHECK (
    BINARY schedule_type IN (
      BINARY 'exam', BINARY 'performance', BINARY 'assignment', BINARY 'other'
    )
  ),
  CONSTRAINT schedules_row_version_check CHECK (row_version >= 1),
  CONSTRAINT schedules_delete_state_check CHECK (
    (deleted_at IS NULL AND deleted_by_member_id IS NULL AND delete_reason IS NULL)
    OR
    (
      deleted_at IS NOT NULL
      AND deleted_by_member_id IS NOT NULL
      AND (delete_reason IS NULL OR CHAR_LENGTH(delete_reason) <= 300)
    )
  ),
  INDEX schedules_list_index (class_id, deleted_at, due_date, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE meals (
  id BIGINT NOT NULL AUTO_INCREMENT,
  edu_office_code VARCHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  school_code VARCHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meal_date DATE NOT NULL,
  meal_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  menu_json JSON NOT NULL,
  source VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'seed',
  source_loaded_on DATE,
  calorie_kcal_tenths INT,
  source_updated_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT meals_school_date_type_unique UNIQUE (
    edu_office_code, school_code, meal_date, meal_type
  ),
  CONSTRAINT meals_school_fk
    FOREIGN KEY (edu_office_code, school_code)
    REFERENCES schools (edu_office_code, school_code)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meals_type_check CHECK (
    BINARY meal_type IN (BINARY 'breakfast', BINARY 'lunch', BINARY 'dinner')
  ),
  CONSTRAINT meals_menu_array_check CHECK (
    JSON_VALID(menu_json)
    AND JSON_TYPE(menu_json) = 'ARRAY'
    AND JSON_LENGTH(menu_json) BETWEEN 1 AND 50
  ),
  CONSTRAINT meals_source_check CHECK (BINARY source IN (BINARY 'seed', BINARY 'neis')),
  CONSTRAINT meals_source_metadata_check CHECK (
    (BINARY source = BINARY 'seed' AND source_loaded_on IS NULL)
    OR
    (BINARY source = BINARY 'neis' AND source_loaded_on IS NOT NULL)
  ),
  CONSTRAINT meals_calorie_kcal_tenths_check CHECK (
    calorie_kcal_tenths BETWEEN 0 AND 99999
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
