import { ApiProperty } from "@nestjs/swagger";

import type {
  AttendanceAccountState,
  AttendanceHistoryCounts,
  AttendanceHistoryItem,
  AttendanceMembershipState,
  AttendanceNotificationStatus,
  AttendanceNotificationType,
} from "./attendance-notifications.types.js";

const TYPES: AttendanceNotificationType[] = ["late", "absent", "early"];
const STATUSES: AttendanceNotificationStatus[] = ["pending", "acknowledged"];

export class AttendanceNotificationItemResponseDto {
  @ApiProperty({ format: "date-time", nullable: true, type: String })
  acknowledged_at!: string | null;

  @ApiProperty({
    example: "08:30",
    nullable: true,
    pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
    type: String,
  })
  expected_time!: string | null;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ enum: TYPES })
  notification_type!: AttendanceNotificationType;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ enum: STATUSES })
  status!: AttendanceNotificationStatus;

  @ApiProperty({ format: "date-time", type: String })
  submitted_at!: string;

  @ApiProperty({ format: "date-time", type: String })
  updated_at!: string;
}

export class AttendanceTeacherItemResponseDto extends AttendanceNotificationItemResponseDto {
  @ApiProperty({ enum: ["active", "inactive", "deleted"] })
  account_state!: AttendanceAccountState;

  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  member_id!: string;

  @ApiProperty({ enum: ["approved", "left", "removed", "account_deleted"] })
  membership_state!: AttendanceMembershipState;

  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  student_number!: number | null;
}

export class AttendanceCountsResponseDto {
  @ApiProperty({ minimum: 0, type: Number })
  absent!: number;

  @ApiProperty({ minimum: 0, type: Number })
  acknowledged!: number;

  @ApiProperty({ minimum: 0, type: Number })
  early!: number;

  @ApiProperty({ minimum: 0, type: Number })
  late!: number;

  @ApiProperty({ minimum: 0, type: Number })
  pending!: number;

  @ApiProperty({ minimum: 0, type: Number })
  total!: number;
}

export class AttendanceHistoryCountsResponseDto implements AttendanceHistoryCounts {
  @ApiProperty({ minimum: 0, type: Number })
  absent!: number;

  @ApiProperty({ minimum: 0, type: Number })
  early!: number;

  @ApiProperty({ minimum: 0, type: Number })
  late!: number;

  @ApiProperty({ minimum: 0, type: Number })
  total!: number;
}

export class AttendanceHistoryItemResponseDto implements AttendanceHistoryItem {
  @ApiProperty({
    example: "08:30",
    nullable: true,
    pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
    type: String,
  })
  expected_time!: string | null;

  @ApiProperty({ example: "2026-07-31", format: "date", type: String })
  notification_date!: string;

  @ApiProperty({ enum: TYPES })
  notification_type!: AttendanceNotificationType;

  @ApiProperty({ enum: STATUSES })
  status!: AttendanceNotificationStatus;
}

export class AttendanceHistoryRangeResponseDto {
  @ApiProperty({ example: "2025-08-01", format: "date", type: String })
  from!: string;

  @ApiProperty({ example: "2026-07-31", format: "date", type: String })
  to!: string;
}

export class AttendanceStudentHistoryResponseDto {
  @ApiProperty({ type: AttendanceHistoryCountsResponseDto })
  counts!: AttendanceHistoryCountsResponseDto;

  @ApiProperty({ type: () => [AttendanceHistoryItemResponseDto] })
  items!: AttendanceHistoryItemResponseDto[];

  @ApiProperty({ type: AttendanceHistoryRangeResponseDto })
  range!: AttendanceHistoryRangeResponseDto;

  @ApiProperty({ enum: ["student"] })
  role!: "student";

  @ApiProperty({ example: "2026-07-31", format: "date", type: String })
  server_today!: string;
}

export class AttendanceStudentTodayResponseDto {
  @ApiProperty({ nullable: true, type: AttendanceNotificationItemResponseDto })
  notification!: AttendanceNotificationItemResponseDto | null;

  @ApiProperty({ enum: ["student"] })
  role!: "student";

  @ApiProperty({ example: "2026-07-18", format: "date", type: String })
  server_today!: string;
}

export class AttendanceTeacherTodayResponseDto {
  @ApiProperty({ type: AttendanceCountsResponseDto })
  counts!: AttendanceCountsResponseDto;

  @ApiProperty({ type: () => [AttendanceTeacherItemResponseDto] })
  items!: AttendanceTeacherItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ enum: ["teacher"] })
  role!: "teacher";

  @ApiProperty({ example: "2026-07-18", format: "date", type: String })
  server_today!: string;
}
