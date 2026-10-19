-- Up Migration

ALTER TABLE polls
  ADD COLUMN ballot_visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN results_policy TEXT NOT NULL DEFAULT 'after_vote',
  ADD CONSTRAINT polls_ballot_visibility_check CHECK (
    ballot_visibility IN ('private', 'teacher_visible')
  ),
  ADD CONSTRAINT polls_results_policy_check CHECK (
    results_policy IN ('after_vote', 'after_close', 'teacher_only')
  );

-- Down Migration

DO $poll_visibility_rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM polls
    WHERE ballot_visibility <> 'private'
       OR results_policy <> 'after_vote'
  ) THEN
    RAISE EXCEPTION
      'poll visibility rollback requires every poll to use private and after_vote defaults';
  END IF;
END
$poll_visibility_rollback_guard$;

ALTER TABLE polls
  DROP CONSTRAINT polls_results_policy_check,
  DROP CONSTRAINT polls_ballot_visibility_check,
  DROP COLUMN results_policy,
  DROP COLUMN ballot_visibility;
