import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export const ADMIN_CLASS_STATUSES = ["active", "suspended", "archived"] as const;
export type AdminClassStatus = (typeof ADMIN_CLASS_STATUSES)[number];

/** 관리자 학교·반 목록: 검색어 없이 전체를 쪽 단위로 본다(검색어는 학교 이름·반 이름). */
export class ListAdminClassesQueryDto {
  @ApiPropertyOptional({ maxLength: 100, minLength: 2, type: String })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(2, 100)
  @IsPlainText()
  search?: string;

  @ApiPropertyOptional({ enum: ADMIN_CLASS_STATUSES })
  @IsOptional()
  @IsIn(ADMIN_CLASS_STATUSES)
  status?: AdminClassStatus;

  @ApiPropertyOptional({ maximum: 10_000, minimum: 1, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;
}

export const ADMIN_ACTIVITY_DAYS = [7, 30] as const;
export type AdminActivityDays = (typeof ADMIN_ACTIVITY_DAYS)[number];

/** 관리자 반 활동 현황: 최근 7일 또는 30일의 건수만 본다. */
export class ListAdminClassActivityQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_ACTIVITY_DAYS, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(ADMIN_ACTIVITY_DAYS)
  days?: AdminActivityDays;

  @ApiPropertyOptional({ maximum: 10_000, minimum: 1, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;
}

/** 관리자 첫 화면 일별 추이: 최근 7일 또는 30일. */
export class AdminActivityTrendQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_ACTIVITY_DAYS, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(ADMIN_ACTIVITY_DAYS)
  days?: AdminActivityDays;
}

/** 관리자 로그인 세션 목록: 사용자 세션은 쪽 단위로 본다. */
export class ListAdminSessionsQueryDto {
  @ApiPropertyOptional({ maximum: 10_000, minimum: 1, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;
}

export const ADMIN_SESSION_KINDS = ["user", "admin"] as const;
export type AdminSessionKind = (typeof ADMIN_SESSION_KINDS)[number];

/** 로그인 세션 강제 종료: 어느 쪽 세션인지와 사유(작업 기록에 남는다). */
export class RevokeAdminSessionDto {
  @ApiProperty({ enum: ADMIN_SESSION_KINDS, type: String })
  @IsIn(ADMIN_SESSION_KINDS)
  kind!: AdminSessionKind;

  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}

export const ADMIN_PERSON_ROLES = ["teacher", "student"] as const;
export type AdminPersonRole = (typeof ADMIN_PERSON_ROLES)[number];
export const ADMIN_PERSON_STATUSES = ["active", "pending", "inactive"] as const;
export type AdminPersonStatus = (typeof ADMIN_PERSON_STATUSES)[number];

/** 관리자 선생님·학생 목록: 검색어 없이 전체를 쪽 단위로 본다(메일은 가려서 보낸다). */
export class ListAdminPeopleQueryDto {
  @ApiPropertyOptional({ maxLength: 100, minLength: 2, type: String })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @CodePointLength(2, 100)
  @IsPlainText()
  search?: string;

  @ApiPropertyOptional({ enum: ADMIN_PERSON_ROLES })
  @IsOptional()
  @IsIn(ADMIN_PERSON_ROLES)
  role?: AdminPersonRole;

  @ApiPropertyOptional({ enum: ADMIN_PERSON_STATUSES })
  @IsOptional()
  @IsIn(ADMIN_PERSON_STATUSES)
  status?: AdminPersonStatus;

  @ApiPropertyOptional({ maximum: 10_000, minimum: 1, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;
}
