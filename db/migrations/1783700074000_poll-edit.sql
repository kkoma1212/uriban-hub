-- Up Migration
-- Teacher edits of an open poll (2026-10-04 user decision). Settings stay fixed; options
-- change only while no vote exists (enforced by the API inside the poll row lock).
INSERT INTO audit_log_actions (action) VALUES ('poll.updated');
GRANT UPDATE (title, description, option_count, closes_at) ON polls TO classhub_app;

-- Down Migration
-- Reverting code must never erase edit evidence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE action = 'poll.updated') THEN
    RAISE EXCEPTION 'Poll edit evidence exists; retain its audit action';
  END IF;
END $$;
REVOKE UPDATE (title, description, option_count, closes_at) ON polls FROM classhub_app;
DELETE FROM audit_log_actions WHERE action = 'poll.updated';
