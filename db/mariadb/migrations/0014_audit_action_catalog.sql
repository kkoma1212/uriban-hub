-- T-HUB-64 phase 0014: isolated synthetic QA only; runtime activation blocked.
-- Source: 1783700030000_audit-action-catalog.sql Up.
-- Both FK columns use NOPAD to retain the old BINARY CHECK's trailing-space distinction.
-- ASCII/64 is the existing action-column bound; unrestricted PostgreSQL TEXT remains a port gap.
SET time_zone = '+00:00';
SET NAMES utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE audit_log_actions (
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_nopad_bin NOT NULL,
  PRIMARY KEY (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO audit_log_actions (action) VALUES
  ('class.created'), ('class.updated'), ('class.suspended'), ('class.reactivated'),
  ('class.archived'), ('invite_code.created'), ('invite_code.revoked'),
  ('member.requested'), ('member.request_canceled'), ('member.approved'),
  ('member.rejected'), ('member.left'), ('member.removed'), ('member.rejoin_allowed'),
  ('member.profile_updated'), ('member.account_deleted'), ('class.teacher_transferred'),
  ('notice.created'), ('notice.updated'), ('notice.deleted'),
  ('notice.reminder_created'),
  ('supply.created'), ('supply.updated'), ('supply.deleted'),
  ('supply.reminder_created'),
  ('schedule.created'), ('schedule.updated'), ('schedule.deleted'),
  ('attendance_notification.created'), ('attendance_notification.updated'),
  ('attendance_notification.canceled'), ('attendance_notification.acknowledged'),
  ('poll.created'), ('poll.deleted'),
  ('seat_draw.created'), ('seat_draw.adjusted'), ('seat_draw.published'),
  ('seat_draw.superseded'), ('seat_draw.deleted'),
  ('team_draw.created'), ('team_draw.adjusted'), ('team_draw.published'),
  ('team_draw.superseded'), ('team_draw.deleted'),
  ('duty_role.created'), ('duty_role.updated'), ('duty_role.archived'),
  ('duty_roster.created'), ('duty_roster.published'), ('duty_roster.superseded'),
  ('duty_roster.deleted');

-- phase14 guard begin
DELIMITER //
BEGIN NOT ATOMIC
  IF (SELECT COUNT(*) FROM audit_log_actions) <> 51 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 31401,
      MESSAGE_TEXT = 'audit action catalog seed drifted: expected 51 rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM audit_logs AS logs
    LEFT JOIN audit_log_actions AS catalog ON BINARY catalog.action = BINARY logs.action
    WHERE catalog.action IS NULL
  ) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 31402,
      MESSAGE_TEXT = 'audit rows use actions missing from the catalog';
  END IF;
END//
DELIMITER ;
-- phase14 guard end

-- Replace only the action CHECK; the JSON/shape/privacy checks stay visible and unchanged.
-- RESTRICT prevents renaming or deleting a catalog entry used by existing audit rows.
ALTER TABLE audit_logs
  MODIFY COLUMN action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_nopad_bin NOT NULL,
  DROP CONSTRAINT audit_logs_action_check,
  ADD CONSTRAINT audit_logs_action_catalog_fkey
    FOREIGN KEY (action) REFERENCES audit_log_actions (action)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
