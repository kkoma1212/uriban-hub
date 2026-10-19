-- Up Migration

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted',
    'notice.reminder_created',
    'supply.created', 'supply.updated', 'supply.deleted',
    'supply.reminder_created',
    'schedule.created', 'schedule.updated', 'schedule.deleted',
    'attendance_notification.created', 'attendance_notification.updated',
    'attendance_notification.canceled', 'attendance_notification.acknowledged',
    'poll.created', 'poll.deleted',
    'seat_draw.created', 'seat_draw.adjusted', 'seat_draw.published',
    'seat_draw.superseded', 'seat_draw.deleted',
    'team_draw.created', 'team_draw.adjusted', 'team_draw.published',
    'team_draw.superseded', 'team_draw.deleted'
  ));

-- Down Migration

DO $team_draw_adjustment_audit_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE action = 'team_draw.adjusted') THEN
    RAISE EXCEPTION
      'team draw adjustment audit rollback requires adjusted audit rows to be empty';
  END IF;
END
$team_draw_adjustment_audit_rollback_guard$;

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'class.created', 'class.updated', 'class.suspended', 'class.reactivated',
    'class.archived', 'invite_code.created', 'invite_code.revoked',
    'member.requested', 'member.request_canceled', 'member.approved',
    'member.rejected', 'member.left', 'member.removed', 'member.rejoin_allowed',
    'member.profile_updated', 'member.account_deleted', 'class.teacher_transferred',
    'notice.created', 'notice.updated', 'notice.deleted',
    'notice.reminder_created',
    'supply.created', 'supply.updated', 'supply.deleted',
    'supply.reminder_created',
    'schedule.created', 'schedule.updated', 'schedule.deleted',
    'attendance_notification.created', 'attendance_notification.updated',
    'attendance_notification.canceled', 'attendance_notification.acknowledged',
    'poll.created', 'poll.deleted',
    'seat_draw.created', 'seat_draw.adjusted', 'seat_draw.published',
    'seat_draw.superseded', 'seat_draw.deleted',
    'team_draw.created', 'team_draw.published', 'team_draw.superseded',
    'team_draw.deleted'
  ));
