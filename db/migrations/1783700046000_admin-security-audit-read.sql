-- Up Migration

/*
 * The administrator audit screen reads the worker-written security ledger.
 * Keep actor identifiers, IP addresses, e-mail digests, HMAC metadata, and
 * user agents outside the HTTP application's privilege surface. Only the
 * fields rendered by the read-only administrator endpoint are exposed.
 */
GRANT SELECT (
  id,
  event_id,
  action,
  method,
  resource,
  sanitized_path,
  deny_reason,
  failure_code,
  created_at,
  request_id,
  target_class_id
) ON security_audit_logs TO classhub_app;

-- Down Migration

REVOKE SELECT (
  id,
  event_id,
  action,
  method,
  resource,
  sanitized_path,
  deny_reason,
  failure_code,
  created_at,
  request_id,
  target_class_id
) ON security_audit_logs FROM classhub_app;
