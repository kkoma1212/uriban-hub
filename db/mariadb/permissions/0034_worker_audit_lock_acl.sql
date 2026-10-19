-- REVIEW CANDIDATE ONLY: no runtime activation or shared/production execution here.
-- Requires the reviewed 0033 worker_security_audit_lock_keys table first.
-- Existing worker baseline and runtime-grant-catalog.json remain unchanged.
-- Opt in only with runtimeRole=worker and runtimeGrantProfile=worker_security_audit_v1.
-- The exact envelope is baseline security_audit_logs SELECT/INSERT plus these two grants.
-- No UPDATE, DELETE, global/schema/role grant or GRANT OPTION is authorized.
-- The isolated QA runner substitutes only its attested schema and probe worker account.
-- runtimeActivationApplied=false; realMariaDbVerified=false.
GRANT INSERT ON classhub_mariadb_phase1_dev.`worker_security_audit_lock_keys` TO 'classhub_worker'@'%';
GRANT SELECT ON classhub_mariadb_phase1_dev.`worker_security_audit_lock_keys` TO 'classhub_worker'@'%';
