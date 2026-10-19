import type {
  AttendanceMutationItem,
  AttendanceMutationStatus,
  AttendanceMutationType,
} from "./attendance-notifications-command.types.js";

export interface AttendanceMutationViewRow {
  acknowledged_at: Date | null;
  expected_time: string | null;
  id: string;
  notification_type: string;
  row_version: string;
  status: string;
  submitted_at: Date;
  updated_at: Date;
}

export function attendanceMutationItem(row: AttendanceMutationViewRow): AttendanceMutationItem {
  return {
    acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
    expected_time: row.expected_time === null ? null : row.expected_time.slice(0, 5),
    id: row.id,
    notification_type: row.notification_type as AttendanceMutationType,
    row_version: row.row_version,
    status: row.status as AttendanceMutationStatus,
    submitted_at: row.submitted_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
