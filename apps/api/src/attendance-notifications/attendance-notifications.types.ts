export type AttendanceNotificationType = "absent" | "early" | "late";
export type AttendanceNotificationStatus = "acknowledged" | "pending";
export type AttendanceNotificationTypeFilter = "all" | AttendanceNotificationType;
export type AttendanceNotificationStatusFilter = "all" | AttendanceNotificationStatus;
export type AttendanceAccountState = "active" | "deleted" | "inactive";
export type AttendanceMembershipState = "account_deleted" | "approved" | "left" | "removed";

export interface AttendanceNotificationItem {
  acknowledged_at: string | null;
  expected_time: string | null;
  id: string;
  notification_type: AttendanceNotificationType;
  row_version: string;
  status: AttendanceNotificationStatus;
  submitted_at: string;
  updated_at: string;
}

export interface AttendanceTeacherItem extends AttendanceNotificationItem {
  account_state: AttendanceAccountState;
  display_name: string;
  member_id: string;
  membership_state: AttendanceMembershipState;
  student_number: number | null;
}

export interface AttendanceCounts {
  absent: number;
  acknowledged: number;
  early: number;
  late: number;
  pending: number;
  total: number;
}

export interface AttendanceHistoryCounts {
  absent: number;
  early: number;
  late: number;
  total: number;
}

export interface AttendanceHistoryItem {
  expected_time: string | null;
  notification_date: string;
  notification_type: AttendanceNotificationType;
  status: AttendanceNotificationStatus;
}

export interface AttendanceStudentHistoryResult {
  counts: AttendanceHistoryCounts;
  items: AttendanceHistoryItem[];
  range: {
    from: string;
    to: string;
  };
  role: "student";
  server_today: string;
}

export interface AttendanceStudentTodayResult {
  notification: AttendanceNotificationItem | null;
  role: "student";
  server_today: string;
}

export interface AttendanceTeacherTodayResult {
  counts: AttendanceCounts;
  items: AttendanceTeacherItem[];
  next_cursor: string | null;
  role: "teacher";
  server_today: string;
}

export type AttendanceTodayResult = AttendanceStudentTodayResult | AttendanceTeacherTodayResult;

export interface GetAttendanceTodayQuery {
  actorUserId: string;
  cursor?: string;
  status: AttendanceNotificationStatusFilter;
  type: AttendanceNotificationTypeFilter;
}

export interface GetAttendanceHistoryQuery {
  actorUserId: string;
  from: string;
  to: string;
}
