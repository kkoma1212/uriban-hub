export type AttendanceMutationType = "absent" | "early" | "late";
export type AttendanceMutationStatus = "acknowledged" | "canceled" | "pending";

export interface AttendanceMutationItem {
  [key: string]: null | string;

  acknowledged_at: string | null;
  expected_time: string | null;
  id: string;
  notification_type: AttendanceMutationType;
  row_version: string;
  status: AttendanceMutationStatus;
  submitted_at: string;
  updated_at: string;
}

export interface AttendanceMutationBody {
  expectedTime: string | null;
  notificationType: AttendanceMutationType;
}

export interface AttendanceCommandContext {
  actorUserId: string;
  requestId: string;
  serverToday: string | string[] | undefined;
}

export interface CreateAttendanceCommand extends AttendanceCommandContext, AttendanceMutationBody {
  idempotencyKey: string | string[] | undefined;
}

export interface UpdateAttendanceCommand extends AttendanceCommandContext, AttendanceMutationBody {
  attendanceId: string;
  ifMatch: string | string[] | undefined;
}

export interface AttendanceStateCommand extends AttendanceCommandContext {
  attendanceId: string;
  ifMatch: string | string[] | undefined;
}

export interface CreateAttendanceResult {
  item: AttendanceMutationItem;
  statusCode: 200 | 201;
}
