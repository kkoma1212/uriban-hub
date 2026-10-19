-- Up Migration

GRANT UPDATE (absolute_expires_at) ON admin_sessions TO classhub_app;

-- Down Migration

REVOKE UPDATE (absolute_expires_at) ON admin_sessions FROM classhub_app;
