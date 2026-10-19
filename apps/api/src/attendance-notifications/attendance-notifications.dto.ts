import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsIn, IsString, Matches, ValidateIf } from "class-validator";

import type {
  AttendanceNotificationStatusFilter,
  AttendanceNotificationTypeFilter,
} from "./attendance-notifications.types.js";

export class GetAttendanceTodayQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: "all", enum: ["all", "pending", "acknowledged"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["all", "pending", "acknowledged"])
  status?: AttendanceNotificationStatusFilter;

  @ApiPropertyOptional({ default: "all", enum: ["all", "late", "absent", "early"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["all", "late", "absent", "early"])
  type?: AttendanceNotificationTypeFilter;
}

export class GetAttendanceHistoryQueryDto {
  @ApiProperty({ example: "2025-08-01", format: "date", type: String })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  from!: string;

  @ApiProperty({ example: "2026-07-31", format: "date", type: String })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  to!: string;
}
