import { ApiProperty } from "@nestjs/swagger";

import {
  BOOTSTRAP_ALLOWED_ACTIONS,
  BOOTSTRAP_DESTINATIONS,
  type BootstrapAllowedAction,
  type BootstrapDestination,
  type BootstrapResult,
} from "./bootstrap.types.js";

const POSITIVE_BIGINT_PATTERN = "^[1-9][0-9]*$";

export class BootstrapAccountResponseDto {
  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({
    description:
      "본인 메일의 앞 두 글자만 보이게 가린 값(예: st***@example.com). 인증번호를 보낸 곳 안내용.",
    required: false,
    type: String,
  })
  email_masked?: string;

  @ApiProperty({ type: Boolean })
  email_verified!: boolean;

  @ApiProperty({ type: Boolean })
  is_active!: boolean;

  @ApiProperty({ enum: ["student", "teacher"], nullable: true, required: false, type: String })
  signup_role?: "student" | "teacher" | null;
}

export class BootstrapCurrentClassResponseDto {
  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  id!: string;

  @ApiProperty({ maxLength: 40, type: String })
  name!: string;

  @ApiProperty({ maxLength: 401, nullable: true, type: String })
  school_address!: string | null;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  school_homepage_url!: string | null;

  @ApiProperty({ maxLength: 100, type: String })
  school_name!: string;

  @ApiProperty({ maxLength: 50, nullable: true, type: String })
  school_phone_number!: string | null;

  @ApiProperty({ enum: ["active", "suspended"], type: String })
  status!: "active" | "suspended";
}

export class BootstrapCurrentMembershipResponseDto {
  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  class_id!: string;

  @ApiProperty({ maxLength: 20, minLength: 2, nullable: true, type: String })
  display_name_in_class!: string | null;

  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  id!: string;

  @ApiProperty({ enum: ["student", "teacher"], type: String })
  role!: "student" | "teacher";

  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  student_number!: number | null;

  @ApiProperty({ enum: ["approved", "pending"], type: String })
  status!: "approved" | "pending";
}

export class BootstrapTeacherProfileResponseDto {
  @ApiProperty({ enum: ["active", "revoked"], type: String })
  status!: "active" | "revoked";

  @ApiProperty({ type: Boolean })
  temporary_password_must_change!: boolean;
}

export class BootstrapResponseDto implements BootstrapResult {
  @ApiProperty({
    description: "Opaque session comparison value; not an authentication credential.",
    pattern: "^v1\\.[A-Za-z0-9_-]{43}$",
    type: String,
  })
  session_context!: string;

  @ApiProperty({ type: () => BootstrapAccountResponseDto })
  account!: BootstrapAccountResponseDto;

  @ApiProperty({ enum: BOOTSTRAP_ALLOWED_ACTIONS, isArray: true, type: String })
  allowed_actions!: BootstrapAllowedAction[];

  @ApiProperty({ nullable: true, type: () => BootstrapCurrentClassResponseDto })
  current_class!: BootstrapCurrentClassResponseDto | null;

  @ApiProperty({ nullable: true, type: () => BootstrapCurrentMembershipResponseDto })
  current_membership!: BootstrapCurrentMembershipResponseDto | null;

  @ApiProperty({ enum: BOOTSTRAP_DESTINATIONS, type: String })
  destination!: BootstrapDestination;

  @ApiProperty({
    enum: [
      "account_deleted",
      "archived",
      "canceled",
      "left",
      "rejected",
      "rejoin_allowed",
      "removed",
      "transferred",
    ],
    nullable: true,
    type: String,
  })
  last_membership_status!: string | null;

  @ApiProperty({ nullable: true, type: String })
  last_status_reason!: string | null;

  @ApiProperty({ example: "2026-07-18", pattern: "^\\d{4}-\\d{2}-\\d{2}$", type: String })
  server_today!: string;

  @ApiProperty({ nullable: true, type: () => BootstrapTeacherProfileResponseDto })
  teacher_profile!: BootstrapTeacherProfileResponseDto | null;
}
