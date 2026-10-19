import { ApiProperty } from "@nestjs/swagger";

import type {
  AttendanceMutationStatus,
  AttendanceMutationType,
} from "./attendance-notifications-command.types.js";

export class AttendanceMutationItemResponseDto {
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

  @ApiProperty({ enum: ["late", "absent", "early"] })
  notification_type!: AttendanceMutationType;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ enum: ["pending", "acknowledged", "canceled"] })
  status!: AttendanceMutationStatus;

  @ApiProperty({ format: "date-time", type: String })
  submitted_at!: string;

  @ApiProperty({ format: "date-time", type: String })
  updated_at!: string;
}
