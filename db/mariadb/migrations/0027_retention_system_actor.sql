-- Source0027 final system-job actor predicate. Source0041 already supplies the
-- final 22 actions and JSON key allowlists; retain those definitions unchanged.
-- Isolated synthetic QA only; no runtime account privileges are changed.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;
ALTER TABLE operator_audit_logs
  DROP CONSTRAINT operator_audit_logs_actor_check,
  ADD CONSTRAINT operator_audit_logs_actor_check CHECK (
    (BINARY actor_type = BINARY 'operator' AND operator_id IS NOT NULL)
    OR (BINARY actor_type = BINARY 'system' AND operator_id IS NULL
      AND BINARY action IN (
        BINARY 'operator.bootstrapped', BINARY 'operator.credential_recovered',
        BINARY 'retention.executed', BINARY 'reminder.executed', BINARY 'job.failed'
      ))
  );
