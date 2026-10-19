import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsInt, IsString, Matches, Max, Min, ValidateIf } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

export class ListMembersQueryDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(
    /^(pending|approved|removed|rejoin_allowed)(,(pending|approved|removed|rejoin_allowed))*$/u,
  )
  status?: string;
}

export class ApproveMemberDto {
  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(99)
  student_number!: number | null;

  @ApiProperty({ maxLength: 20, minLength: 2, nullable: true, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(2, 20)
  @IsPlainText()
  display_name_in_class!: string | null;
}

export class MemberReasonDto {
  @ApiProperty({ maxLength: 300, nullable: true, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(0, 300)
  @IsPlainText()
  reason!: string | null;
}

export class UpdateMemberProfileDto {
  @ApiPropertyOptional({
    description: "null이면 계정 표시명을 사용합니다.",
    maxLength: 20,
    minLength: 2,
    nullable: true,
    type: String,
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(2, 20)
  @IsPlainText()
  display_name_in_class?: string | null;

  @ApiPropertyOptional({ maximum: 99, minimum: 1, nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(99)
  student_number?: number | null;
}

export class MemberListItemResponseDto {
  @ApiProperty({ enum: ["active", "inactive"] })
  account_state!: "active" | "inactive";

  @ApiPropertyOptional({
    description: "생년월일 칸이 설치된 환경에서만. 담임의 학생 확인용",
    format: "date",
    nullable: true,
    type: String,
  })
  birth_date?: string | null;

  @ApiProperty({ type: String })
  display_name!: string;

  @ApiProperty({ nullable: true, type: String })
  display_name_in_class!: string | null;

  @ApiPropertyOptional({ type: String })
  email_masked?: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  requested_at!: string | null;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ enum: ["pending", "approved", "removed", "rejoin_allowed"] })
  status!: "approved" | "pending" | "rejoin_allowed" | "removed";

  @ApiProperty({ format: "date-time", type: String })
  status_changed_at!: string;

  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  student_number!: number | null;
}

export class ListMembersResponseDto {
  @ApiProperty({ isArray: true, type: MemberListItemResponseDto })
  members!: MemberListItemResponseDto[];
}

export class GetMemberProfileResponseDto {
  @ApiProperty({ type: MemberListItemResponseDto })
  member!: MemberListItemResponseDto;
}

export class UpdateMemberProfileResponseDto {
  @ApiProperty({ type: MemberListItemResponseDto })
  member!: MemberListItemResponseDto;

  @ApiProperty({ type: Boolean })
  profile_updated!: boolean;
}
