-- T-HUB-64 phase 0016: isolated synthetic QA only; runtime activation blocked.
-- Source0033 keeps one in-progress layout per class/member/kind, separate from saved draws.
-- JSON syntax is enforced; payload shape/size and teacher access remain application concerns.
-- Source0034 retention permissions are deferred to final runtime permissions.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE layout_draft_autosaves (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT layout_draft_autosaves_kind_check
    CHECK (BINARY kind IN (BINARY 'seat_draw', BINARY 'team_draw')),
  CONSTRAINT layout_draft_autosaves_class_foreign_key
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT layout_draft_autosaves_member_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE UNIQUE INDEX layout_draft_autosaves_owner_kind_unique
  ON layout_draft_autosaves (class_id, member_id, kind);

-- Last edit time drives the seven-day retention lookup; no database expiry side effect.
CREATE INDEX layout_draft_autosaves_updated_at_index
  ON layout_draft_autosaves (updated_at);
