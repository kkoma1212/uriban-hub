-- Up Migration
-- Preserve the scheduled deadline, creation bounds, options and all existing responses.
ALTER TABLE polls ADD COLUMN closed_at TIMESTAMPTZ;
ALTER TABLE polls ADD CONSTRAINT polls_closed_at_check CHECK (
  closed_at IS NULL OR (closed_at >= created_at AND closed_at <= closes_at)
);
INSERT INTO audit_log_actions (action) VALUES ('poll.closed');
GRANT UPDATE (closed_at, row_version) ON polls TO classhub_app;

-- Down Migration
-- Reverting code must never reopen a closed poll or erase closure evidence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM polls WHERE closed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM audit_logs WHERE action = 'poll.closed') THEN
    RAISE EXCEPTION 'Poll closure evidence exists; retain closed_at and its audit action';
  END IF;
END $$;
REVOKE UPDATE (closed_at, row_version) ON polls FROM classhub_app;
DELETE FROM audit_log_actions WHERE action = 'poll.closed';
ALTER TABLE polls DROP COLUMN closed_at;
