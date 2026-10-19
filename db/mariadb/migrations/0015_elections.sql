-- T-HUB-64 phase 0015: isolated synthetic QA only; runtime activation blocked.
-- Source0031 elections plus source0032 winner result columns/constraints.
-- Participants contain no candidate choice and tallies contain no voter or per-vote timestamp.
-- Source title, snapshots, student number, version and timestamp-shape restrictions are not invented.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE elections (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  class_id BIGINT NOT NULL,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
  
  tie_break VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  results_visibility VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  opened_at DATETIME(6),
  closed_at DATETIME(6),
  published_at DATETIME(6),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  winner_candidate_id BIGINT,
  tie_break_applied BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT elections_tie_break_applied_boolean_check CHECK (tie_break_applied IN (0,1)),
  CONSTRAINT elections_published_requires_winner_check CHECK (BINARY status <> BINARY 'published' OR winner_candidate_id IS NOT NULL),
  CONSTRAINT elections_class_fk FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT elections_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT elections_status_check CHECK (BINARY status IN (BINARY 'draft', BINARY 'open', BINARY 'closed', BINARY 'published')),
  CONSTRAINT elections_tie_break_check
    CHECK (BINARY tie_break IN (BINARY 'revote', BINARY 'elder', BINARY 'teacher_decides')),
  CONSTRAINT elections_results_visibility_check
    CHECK (BINARY results_visibility IN (BINARY 'winner_only', BINARY 'with_counts')),
  CONSTRAINT elections_creator_class_foreign_key FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE election_candidates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  election_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,

  display_name_snapshot TEXT NOT NULL,
  student_number_snapshot INTEGER,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  CONSTRAINT election_candidates_id_election_unique UNIQUE (id, election_id),
  CONSTRAINT election_candidates_election_member_unique UNIQUE (election_id, member_id),
  CONSTRAINT election_candidates_election_class_foreign_key FOREIGN KEY (election_id, class_id)
    REFERENCES elections (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT election_candidates_member_class_foreign_key FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE election_tallies (
  election_id BIGINT NOT NULL,
  candidate_id BIGINT NOT NULL,
  vote_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT election_tallies_pkey PRIMARY KEY (election_id, candidate_id),
  CONSTRAINT election_tallies_vote_count_check CHECK (vote_count >= 0),
  CONSTRAINT election_tallies_candidate_election_foreign_key FOREIGN KEY (candidate_id, election_id)
    REFERENCES election_candidates (id, election_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE election_participants (
  election_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  CONSTRAINT election_participants_pkey PRIMARY KEY (election_id, member_id),
  CONSTRAINT election_participants_election_class_foreign_key FOREIGN KEY (election_id, class_id)
    REFERENCES elections (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT election_participants_member_class_foreign_key FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;


-- Winner references candidates created after the elections table (a deliberate FK cycle).
ALTER TABLE elections
  ADD CONSTRAINT elections_winner_candidate_foreign_key
    FOREIGN KEY (winner_candidate_id, id) REFERENCES election_candidates (id, election_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

INSERT INTO audit_log_actions (action) VALUES
  ('election.created'),
  ('election.candidate_registered'),
  ('election.opened'),
  ('election.closed'),
  ('election.published');
