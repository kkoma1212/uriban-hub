-- REVIEW ONLY: additive candidate, not part of compose initialization or runtime activation.
-- Preserves the approved invariant_core / caller-owned audit boundary.
-- Required to bind audit created_at to the routine's exact OUT DATETIME(6).
-- This expands what a stolen operator credential can write: it can choose an audit timestamp.
-- Activate only with the final role/threat-model review and explicit live approval.
GRANT INSERT (`created_at`) ON classhub_mariadb_phase1_dev.`audit_logs` TO 'classhub_operator'@'%';
GRANT INSERT (`created_at`) ON classhub_mariadb_phase1_dev.`operator_audit_logs` TO 'classhub_operator'@'%';
