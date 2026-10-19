-- Up Migration
-- Administrator inquiry queue and service state.
CREATE TABLE admin_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_admin_account_id BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  internal_note TEXT CHECK (internal_note IS NULL OR char_length(internal_note) <= 5000),
  response TEXT CHECK (response IS NULL OR char_length(response) BETWEEN 1 AND 10000),
  responded_by_admin_account_id BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT admin_inquiries_response_state_check CHECK (
    (response IS NULL AND responded_by_admin_account_id IS NULL AND responded_at IS NULL)
    OR (response IS NOT NULL AND responded_by_admin_account_id IS NOT NULL AND responded_at IS NOT NULL)
  )
);
CREATE INDEX admin_inquiries_queue_index ON admin_inquiries(status, updated_at DESC);
CREATE TABLE admin_system_state (
  key TEXT PRIMARY KEY CHECK (key IN ('maintenance_mode','announcement')),
  value_json JSONB NOT NULL,
  updated_by_admin_account_id BIGINT NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL PRIVILEGES ON admin_inquiries, admin_system_state FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON admin_inquiries TO classhub_app;
GRANT SELECT, INSERT, UPDATE ON admin_system_state TO classhub_app;
-- Down Migration
DO $admin_inquiries_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_inquiries) OR EXISTS (SELECT 1 FROM admin_system_state) THEN
    RAISE EXCEPTION 'admin inquiry/system state data exists; export and remove it before rolling back';
  END IF;
END
$admin_inquiries_rollback_guard$;
REVOKE SELECT, INSERT, UPDATE ON admin_inquiries, admin_system_state FROM classhub_app;
REVOKE ALL PRIVILEGES ON admin_inquiries, admin_system_state FROM PUBLIC;
DROP TABLE admin_system_state;
DROP TABLE admin_inquiries;
