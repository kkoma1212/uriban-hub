import { ApiProperty } from "@nestjs/swagger";
import {
  IsIn,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";

import type { AttendanceMutationType } from "./attendance-notifications-command.types.js";

const MINUTE_TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;

@ValidatorConstraint({ name: "attendanceExpectedTime", async: false })
class AttendanceExpectedTimeConstraint implements ValidatorConstraintInterface {
  defaultMessage(): string {
    return "지각·조퇴는 HH:mm 예정 시각이 필요하고 결석은 null이어야 합니다.";
  }

  validate(value: unknown, arguments_: ValidationArguments): boolean {
    const type = (arguments_.object as { notification_type?: unknown }).notification_type;
    if (type === "absent") return value === null;
    if (type === "late" || type === "early") {
      return typeof value === "string" && MINUTE_TIME_PATTERN.test(value);
    }
    return true;
  }
}

export class AttendanceMutationBodyDto {
  @ApiProperty({
    example: "08:30",
    nullable: true,
    pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
    type: String,
  })
  @Validate(AttendanceExpectedTimeConstraint)
  expected_time!: string | null;

  @ApiProperty({ enum: ["late", "absent", "early"] })
  @IsIn(["late", "absent", "early"])
  notification_type!: AttendanceMutationType;
}

export class EmptyAttendanceMutationBodyDto {}
