import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export enum AdminSystemStateKey {
  Announcement = "announcement",
  MaintenanceMode = "maintenance_mode",
  RequestLimits = "request_limits",
}

export const ADMIN_LEGAL_DOCUMENT_TYPES = [
  "terms",
  "privacy_consent",
  "privacy_policy",
  "guardian_consent",
] as const;
export type AdminLegalDocumentType = (typeof ADMIN_LEGAL_DOCUMENT_TYPES)[number];

export class ListAdminMembersQueryDto {
  @Transform(trimText)
  @IsString()
  @CodePointLength(2, 100)
  @IsPlainText()
  search!: string;
  @IsOptional()
  @IsIn(["pending", "approved", "rejected", "removed", "rejoin_allowed"])
  status?: string;
}

export class ListAdminUsersQueryDto {
  @Transform(trimText)
  @IsString()
  @CodePointLength(2, 100)
  @IsPlainText()
  search!: string;
}

export class UpdateAdminUserStatusDto {
  @ApiProperty({ enum: ["active", "inactive"], type: String })
  @IsIn(["active", "inactive"])
  status!: "active" | "inactive";

  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}

export class ResetAdminUserPasswordDto {
  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}

export class UpdateAdminMemberStatusDto {
  @ApiProperty({ enum: ["approved", "rejected", "removed", "rejoin_allowed"], type: String })
  @IsIn(["approved", "rejected", "removed", "rejoin_allowed"])
  status!: string;
  @ApiPropertyOptional({
    description: "approved 상태에서는 생략할 수 있으며, 다른 상태로 변경할 때는 필수입니다.",
    maxLength: 300,
    minLength: 1,
    type: String,
  })
  @ValidateIf(
    (input: UpdateAdminMemberStatusDto, value: unknown) =>
      input.status !== "approved" || value !== undefined,
  )
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason?: string;
}

/**
 * 감사·보안 기록 조회 공통 조건(총검수 C2-07): 작업(길이 제한), 기간(한국 날짜), 50건씩 넘기기.
 * 조건 없이는 지금처럼 최근 기록부터 보인다.
 */
class AdminAuditPageQueryDto {
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  action?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/u) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/u) to?: string;
  /** 앞에서 건너뛸 건수(0~9950, 50 단위로 '더 보기'). */
  @IsOptional() @Matches(/^(0|[1-9]\d{0,3})$/u) offset?: string;
}

export class ListAdminAuditQueryDto extends AdminAuditPageQueryDto {
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  resource?: string;

  /** 대상 반 번호 */
  @IsOptional() @Matches(/^[1-9]\d{0,18}$/u) target?: string;
}

export class ListAdminAuthAuditQueryDto extends AdminAuditPageQueryDto {
  /** 관리자 계정 번호 */
  @IsOptional() @Matches(/^[1-9]\d{0,18}$/u) actor?: string;
}

export class ListAdminOperationAuditQueryDto extends AdminAuditPageQueryDto {
  /** 작업한 관리자 계정 번호 */
  @IsOptional() @Matches(/^[1-9]\d{0,18}$/u) actor?: string;

  /** 작업 대상 ID(계정·약관·세션 번호 등) */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  target?: string;
}

export class ListAdminInquiriesQueryDto {
  @IsOptional() @IsIn(["open", "in_progress", "resolved", "closed"]) status?: string;
}
export class UpdateAdminInquiryDto {
  @ApiProperty({ enum: ["open", "in_progress", "resolved", "closed"], type: String })
  @IsIn(["open", "in_progress", "resolved", "closed"])
  status!: string;
  @ApiPropertyOptional({
    description: "앞뒤 공백을 제거한 일반 텍스트. 줄바꿈을 허용합니다.",
    maxLength: 5000,
    minLength: 1,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 5000)
  @IsPlainText({ allowLineFeed: true })
  internal_note?: string;

  @ApiPropertyOptional({
    description: "담당 관리자 계정 ID. null을 보내면 담당자 지정을 해제합니다.",
    nullable: true,
    pattern: "^[0-9]+$",
    type: String,
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/u)
  assigned_admin_account_id?: string | null;

  @ApiPropertyOptional({
    description: "앞뒤 공백을 제거한 일반 텍스트. 줄바꿈을 허용합니다.",
    maxLength: 10000,
    minLength: 1,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 10000)
  @IsPlainText({ allowLineFeed: true })
  response?: string;
}
export class UpdateAdminSystemStateDto {
  @ApiProperty({
    description:
      "maintenance_mode는 enabled만, announcement는 enabled와 message를 받습니다. 공지를 켤 때 message는 공백만으로 구성할 수 없습니다.",
    oneOf: [
      {
        additionalProperties: false,
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          message: { description: "줄바꿈을 허용하는 일반 텍스트", maxLength: 500, type: "string" },
        },
        required: ["enabled", "message"],
        type: "object",
      },
    ],
  })
  @IsDefined()
  value!: unknown;
}

export class CreateAdminTermsVersionDto {
  @ApiProperty({ enum: ADMIN_LEGAL_DOCUMENT_TYPES, type: String })
  @IsIn(ADMIN_LEGAL_DOCUMENT_TYPES)
  document_type!: AdminLegalDocumentType;

  @ApiProperty({ maxLength: 80, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  policy_version!: string;

  @ApiProperty({ maxLength: 200, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 200)
  @IsPlainText()
  title!: string;

  @ApiProperty({
    description: "앞뒤 공백을 제거한 일반 텍스트 본문. 줄바꿈을 허용합니다.",
    maxLength: 100000,
    minLength: 1,
    type: String,
  })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100000)
  @IsPlainText({ allowLineFeed: true })
  content!: string;
}

export class UpdateAdminTermsVersionStatusDto {
  @ApiProperty({ enum: ["published", "retired"], type: String })
  @IsIn(["published", "retired"])
  status!: "published" | "retired";

  @ApiPropertyOptional({
    description:
      "published 상태로 변경할 때 필수인 유효한 ISO 8601 시행일시입니다. retired 상태에서는 사용하지 않습니다.",
    type: String,
  })
  @ValidateIf((value: UpdateAdminTermsVersionStatusDto) => value.status === "published")
  @IsISO8601({ strict: true })
  effective_at?: string;

  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}

/** 시범 판정 지표: 한국 날짜 기간(처음·끝 포함). 둘 다 없으면 오늘까지 최근 30일. */
export class AdminReconfirmReportQueryDto {
  @ApiPropertyOptional({ example: "2026-10-01", format: "date", type: String })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  from?: string;

  @ApiPropertyOptional({ example: "2026-10-31", format: "date", type: String })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  to?: string;
}

export class ListAdminTermsConsentsQueryDto {
  @IsIn(["terms", "privacy"]) consent_type!: "terms" | "privacy";
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  policy_version!: string;
}
