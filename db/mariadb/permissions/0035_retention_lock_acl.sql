-- REVIEW CANDIDATE ONLY: runtimeActivationApplied=false; no shared/production application.
-- Requires 0035_retention_lock_keys.sql and all four committed immutable seeds.
-- Opt in only with runtimeRole=retention and runtimeGrantProfile=retention_v1.
-- Exact envelope: existing retention baseline 45 entries plus this single SELECT entry.
-- No INSERT/UPDATE/DELETE, global/schema/role grant or GRANT OPTION on the lock table.
GRANT SELECT ON classhub_mariadb_phase1_dev.`retention_lock_keys` TO 'classhub_retention'@'%';
