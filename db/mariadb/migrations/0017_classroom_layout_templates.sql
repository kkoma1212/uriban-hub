-- T-HUB-64 phase 0017: isolated synthetic QA only; runtime activation blocked.
-- Source0035: named classroom layouts are separate from in-progress autosaves.
-- Keep TEXT and enforce the source bound before relying on its 40-character index prefix.
-- Every valid name is fully indexed; overlong trailing spaces cannot be silently truncated.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE classroom_layout_templates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  name TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  payload JSON NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT classroom_layout_templates_class_foreign_key
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT classroom_layout_templates_member_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT classroom_layout_templates_name_check CHECK (
    BINARY name = BINARY TRIM(name)
    AND CHAR_LENGTH(name) BETWEEN 1 AND 40
    AND name NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT classroom_layout_templates_row_version_check CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE UNIQUE INDEX classroom_layout_templates_owner_name_unique
  ON classroom_layout_templates (class_id, member_id, name(40));

CREATE INDEX classroom_layout_templates_owner_updated_at_index
  ON classroom_layout_templates (class_id, member_id, updated_at DESC);
