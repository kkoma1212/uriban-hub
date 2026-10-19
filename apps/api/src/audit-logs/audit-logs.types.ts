export const CLASS_AUDIT_ACTIONS = [
  "class.created",
  "class.updated",
  "class.suspended",
  "class.reactivated",
  "class.archived",
  "invite_code.created",
  "invite_code.revoked",
  "member.requested",
  "member.request_canceled",
  "member.approved",
  "member.rejected",
  "member.left",
  "member.removed",
  "member.rejoin_allowed",
  "member.profile_updated",
  "member.account_deleted",
  "class.teacher_transferred",
  "notice.created",
  "notice.updated",
  "notice.deleted",
  "notice.reminder_created",
  "supply.created",
  "supply.updated",
  "supply.deleted",
  "supply.reminder_created",
  "schedule.created",
  "schedule.updated",
  "schedule.deleted",
  "schedule.links_updated",
  "attendance_notification.created",
  "attendance_notification.updated",
  "attendance_notification.canceled",
  "attendance_notification.acknowledged",
  "poll.closed",
  "poll.created",
  "poll.deleted",
  "poll.updated",
  "seat_draw.created",
  "seat_draw.adjusted",
  "seat_draw.published",
  "seat_draw.superseded",
  "seat_draw.deleted",
  "team_draw.created",
  "team_draw.adjusted",
  "team_draw.published",
  "team_draw.superseded",
  "team_draw.deleted",
  "duty_role.created",
  "duty_role.updated",
  "duty_role.archived",
  "duty_roster.created",
  "duty_roster.published",
  "duty_roster.superseded",
  "duty_roster.deleted",
  /*
   * 선거는 "누가 만들고 개표했나"만 남긴다(T-HUB-18). 개별 투표는 어떤 형태로도
   * 남기지 않는다 — 남기는 순간 무기명 설계 전체가 무의미해진다.
   */
  "election.created",
  "election.candidate_registered",
  "election.opened",
  "election.closed",
  "election.published",
] as const;

export const CLASS_AUDIT_ACTION_SET: ReadonlySet<string> = new Set(CLASS_AUDIT_ACTIONS);
// 학급 감사는 365일 보관한다(PRD 13.4). 조회 창을 그보다 짧게 두면 살아 있는
// 기록이 화면에서만 사라진다 — 학년 중간에 부임한 담임이 전임 시절 기록을 못 보는
// 것이 그 증상이었다(T-HUB-13). 상한을 보관기간에 맞춘다.
export const AUDIT_LOG_DAY_OPTIONS = [7, 30, 90, 180, 365] as const;

export type ClassAuditAction = (typeof CLASS_AUDIT_ACTIONS)[number];
export type AuditLogDays = (typeof AUDIT_LOG_DAY_OPTIONS)[number];

export type AuditSafeValue = boolean | number | string | null;
export type AuditSafeSnapshot = Record<string, AuditSafeValue>;

export interface AuditLogActorSnapshot {
  display_name: string;
  role: "operator" | "student" | "teacher";
}

export interface AuditLogTarget {
  id: string;
  snapshot: AuditSafeSnapshot | null;
  type: string;
}

export interface AuditLogItem {
  action: ClassAuditAction;
  actor: AuditLogActorSnapshot;
  after: AuditSafeSnapshot | null;
  before: AuditSafeSnapshot | null;
  created_at: string;
  reason: string | null;
  target: AuditLogTarget;
}

export interface AuditLogListResult {
  items: AuditLogItem[];
  next_cursor: string | null;
}

export interface AuditLogListQuery {
  action: ClassAuditAction | null;
  actorUserId: string;
  cursor?: string;
  days: AuditLogDays;
}
