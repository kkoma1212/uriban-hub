-- T-HUB-64 MariaDB baseline phase 0010 (development only).
-- PostgreSQL sources: 1783700016000_class-polls.sql and
-- 1783700021000_poll-visibility-and-results-policy.sql (Up only).
-- Isolated synthetic QA only. Final visibility columns are folded into this baseline.
-- Application voting, visibility, locking and all runtime privileges remain separate.

SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE polls (
  id BIGINT NOT NULL AUTO_INCREMENT,
  class_id BIGINT NOT NULL,
  created_by_member_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  option_count SMALLINT NOT NULL,
  closes_at DATETIME(6) NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  ballot_visibility VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'private',
  results_policy VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'after_vote',
  PRIMARY KEY (id),
  CONSTRAINT polls_id_class_unique UNIQUE (id, class_id),
  CONSTRAINT polls_class_fk
    FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE RESTRICT,
  CONSTRAINT polls_creator_class_foreign_key
    FOREIGN KEY (created_by_member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT polls_title_check CHECK (
    BINARY title = BINARY TRIM(title)
    AND CHAR_LENGTH(title) BETWEEN 1 AND 100
    AND title NOT REGEXP '[[:cntrl:]]'
  ),
  CONSTRAINT polls_description_check CHECK (
    description IS NULL OR (
      BINARY description = BINARY TRIM(description)
      AND CHAR_LENGTH(description) BETWEEN 1 AND 500
    )
  ),
  CONSTRAINT polls_option_count_check CHECK (option_count BETWEEN 2 AND 10),
  CONSTRAINT polls_closes_at_check CHECK (
    closes_at >= created_at + INTERVAL 5 MINUTE
    AND closes_at <= created_at + INTERVAL 30 DAY
  ),
  CONSTRAINT polls_row_version_check CHECK (row_version >= 1),
  CONSTRAINT polls_ballot_visibility_check CHECK (
    BINARY ballot_visibility IN (BINARY 'private', BINARY 'teacher_visible')
  ),
  CONSTRAINT polls_results_policy_check CHECK (
    BINARY results_policy IN (BINARY 'after_vote', BINARY 'after_close', BINARY 'teacher_only')
  ),
  INDEX polls_class_status_index (class_id, closes_at DESC, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE poll_options (
  id BIGINT NOT NULL AUTO_INCREMENT,
  poll_id BIGINT NOT NULL,
  position SMALLINT NOT NULL,
  label TEXT NOT NULL,
  -- Reuse phase-0002's measured PostgreSQL en_US.utf8 whitespace and case fold.
  -- NOPAD binary identity preserves a significant final space after normalization.
  label_normalized VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin
    GENERATED ALWAYS AS (
      LOWER(
        REGEXP_REPLACE(
          TRIM(label),
          '[\\x{0009}-\\x{000D}\\x{0020}\\x{0085}\\x{2000}-\\x{2006}\\x{2008}-\\x{200A}\\x{2028}-\\x{2029}\\x{205F}\\x{3000}]+',
          ' '
        ) COLLATE utf8mb4_uca1400_as_ci
      )
    ) STORED,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT poll_options_poll_fk
    FOREIGN KEY (poll_id) REFERENCES polls (id) ON DELETE RESTRICT,
  CONSTRAINT poll_options_id_poll_unique UNIQUE (id, poll_id),
  CONSTRAINT poll_options_poll_position_unique UNIQUE (poll_id, position),
  CONSTRAINT poll_options_poll_label_unique UNIQUE (poll_id, label_normalized),
  CONSTRAINT poll_options_position_check CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT poll_options_label_check CHECK (
    BINARY label = BINARY TRIM(label)
    AND CHAR_LENGTH(label) BETWEEN 1 AND 80
    AND label NOT REGEXP '[[:cntrl:]]'
  ),
  INDEX poll_options_poll_position_index (poll_id, position, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE poll_votes (
  id BIGINT NOT NULL AUTO_INCREMENT,
  poll_id BIGINT NOT NULL,
  class_id BIGINT NOT NULL,
  option_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT UTC_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT poll_votes_poll_member_unique UNIQUE (poll_id, member_id),
  CONSTRAINT poll_votes_poll_class_foreign_key
    FOREIGN KEY (poll_id, class_id)
    REFERENCES polls (id, class_id) ON DELETE RESTRICT,
  CONSTRAINT poll_votes_option_poll_foreign_key
    FOREIGN KEY (option_id, poll_id)
    REFERENCES poll_options (id, poll_id) ON DELETE RESTRICT,
  CONSTRAINT poll_votes_member_class_foreign_key
    FOREIGN KEY (member_id, class_id)
    REFERENCES class_members (id, class_id) ON DELETE RESTRICT,
  INDEX poll_votes_poll_option_index (poll_id, option_id, id),
  INDEX poll_votes_member_index (member_id, poll_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Preserve the existing reminder shape and attendance privacy checks.
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  DROP CONSTRAINT audit_logs_json_allowlist_check,
  ADD CONSTRAINT audit_logs_action_check CHECK (
    BINARY action IN (
      BINARY 'class.created', BINARY 'class.updated', BINARY 'class.suspended',
      BINARY 'class.reactivated', BINARY 'class.archived',
      BINARY 'invite_code.created', BINARY 'invite_code.revoked',
      BINARY 'member.requested', BINARY 'member.request_canceled',
      BINARY 'member.approved', BINARY 'member.rejected', BINARY 'member.left',
      BINARY 'member.removed', BINARY 'member.rejoin_allowed',
      BINARY 'member.profile_updated', BINARY 'member.account_deleted',
      BINARY 'class.teacher_transferred', BINARY 'notice.created',
      BINARY 'notice.updated', BINARY 'notice.deleted', BINARY 'notice.reminder_created',
      BINARY 'supply.created',
      BINARY 'supply.updated', BINARY 'supply.deleted', BINARY 'supply.reminder_created',
      BINARY 'schedule.created',
      BINARY 'schedule.updated', BINARY 'schedule.deleted',
      BINARY 'attendance_notification.created', BINARY 'attendance_notification.updated',
      BINARY 'attendance_notification.canceled', BINARY 'attendance_notification.acknowledged',
      BINARY 'poll.created', BINARY 'poll.deleted'
    )
  ),
  ADD CONSTRAINT audit_logs_json_allowlist_check CHECK (
    CASE
      WHEN action LIKE 'class.%' AND action <> 'class.teacher_transferred' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["class_id","name","academic_year","grade","expected_student_count","status","suspended_reason","archived_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'invite_code.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["invite_code_id","class_id","expires_at","revoked_at","revoke_reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'member.%' OR action = 'class.teacher_transferred' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["member_id","role","status","display_name_snapshot","reason"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["member_id","role","status","display_name_snapshot","reason"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["member_id","role","status","display_name_snapshot","reason"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action IN ('notice.reminder_created', 'supply.reminder_created') THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '[]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '[]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["reminder_batch_id","content_revision","current_unresolved_count","created_count","cooldown_suppressed_count"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'notice.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["notice_id","title","is_important","content_revision","published_at","deleted_at","category","audience_mode","recipient_count"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'supply.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["supply_id","title","needed_on","content_revision","deleted_at","audience_mode","recipient_count"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'attendance_notification.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["attendance_notification_id","notification_type","notification_date","status"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["attendance_notification_id","notification_type","notification_date","status"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["attendance_notification_id","notification_type","notification_date","status"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      WHEN action LIKE 'poll.%' THEN
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["poll_id","title","closes_at","option_count","vote_count","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
      ELSE
        (
          target_snapshot IS NULL
          OR (
            JSON_TYPE(target_snapshot) = 'OBJECT'
            AND JSON_CONTAINS(
              '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]',
              JSON_KEYS(target_snapshot)
            ) = 1
          )
        )
        AND
        (
          before_json IS NULL
          OR (
            JSON_TYPE(before_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]',
              JSON_KEYS(before_json)
            ) = 1
          )
        )
        AND
        (
          after_json IS NULL
          OR (
            JSON_TYPE(after_json) = 'OBJECT'
            AND JSON_CONTAINS(
              '["schedule_id","title","subject","schedule_type","due_date","deleted_at"]',
              JSON_KEYS(after_json)
            ) = 1
          )
        )
    END
  );
