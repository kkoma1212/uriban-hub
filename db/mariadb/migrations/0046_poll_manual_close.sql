-- Preserve the scheduled deadline, creation bounds, options and existing responses.
ALTER TABLE polls
  ADD COLUMN closed_at DATETIME(6) NULL,
  ADD CONSTRAINT polls_closed_at_check CHECK (
    closed_at IS NULL OR (closed_at >= created_at AND closed_at <= closes_at)
  );
INSERT INTO audit_log_actions (action) VALUES ('poll.closed');
