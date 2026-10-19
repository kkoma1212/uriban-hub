import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsDefined,
  IsIn,
  IsString,
  Matches,
  ValidateIf,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type { ScheduleListScope, ScheduleType } from "./schedules.types.js";

const SCHEDULE_TYPES: ScheduleType[] = ["exam", "performance", "assignment", "other"];

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class ListSchedulesQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiProperty({ enum: ["upcoming", "today", "this_week", "past"] })
  @IsIn(["upcoming", "today", "this_week", "past"])
  scope!: ScheduleListScope;

  @ApiPropertyOptional({ enum: SCHEDULE_TYPES })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(SCHEDULE_TYPES)
  schedule_type?: ScheduleType;

  @ApiPropertyOptional({ description: "과목·제목·설명 검색어", maxLength: 50, type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 50)
  q?: string;
}

export class ScheduleCalendarQueryDto {
  @ApiProperty({ example: "2026-06-28", format: "date", type: String })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  start_date!: string;

  @ApiProperty({ example: "2026-08-08", format: "date", type: String })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  end_date!: string;
}

export class CreateScheduleDto {
  @ApiPropertyOptional({ maxLength: 500, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(0, 500)
  @IsPlainText({ allowLineFeed: true })
  description?: string | null;

  @ApiProperty({ example: "2026-07-15", format: "date", type: String })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  due_date!: string;

  @ApiProperty({ enum: SCHEDULE_TYPES })
  @IsIn(SCHEDULE_TYPES)
  schedule_type!: ScheduleType;

  @ApiPropertyOptional({ maxLength: 30, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(0, 30)
  @IsPlainText()
  subject?: string | null;

  @ApiProperty({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title!: string;
}

export class UpdateScheduleDto {
  @ApiPropertyOptional({ maxLength: 500, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(0, 500)
  @IsPlainText({ allowLineFeed: true })
  description?: string | null;

  @ApiPropertyOptional({ example: "2026-07-15", format: "date", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  due_date?: string;

  @ApiPropertyOptional({ enum: SCHEDULE_TYPES })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(SCHEDULE_TYPES)
  schedule_type?: ScheduleType;

  @ApiPropertyOptional({ maxLength: 30, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(0, 30)
  @IsPlainText()
  subject?: string | null;

  @ApiPropertyOptional({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title?: string;
}

export class DeleteScheduleDto {
  @ApiProperty({ maxLength: 300, nullable: true, type: String })
  @IsDefined()
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(0, 300)
  @IsPlainText()
  reason!: string | null;
}

/** 일정 하나에 연결할 수 있는 공지·준비물 수. 화면 한 번에 훑어볼 수 있는 범위로 둔다. */
export const MAX_SCHEDULE_LINKS = 10;

export class UpdateScheduleLinksDto {
  @ApiProperty({
    description: "이 일정에 연결할 같은 반 공지 ID 전체(비우면 연결 해제)",
    isArray: true,
    maxItems: MAX_SCHEDULE_LINKS,
    type: String,
  })
  @IsDefined()
  @IsArray()
  @ArrayMaxSize(MAX_SCHEDULE_LINKS)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[1-9][0-9]{0,18}$/u, { each: true })
  notice_ids!: string[];

  @ApiProperty({
    description: "이 일정에 연결할 같은 반 준비물 ID 전체(비우면 연결 해제)",
    isArray: true,
    maxItems: MAX_SCHEDULE_LINKS,
    type: String,
  })
  @IsDefined()
  @IsArray()
  @ArrayMaxSize(MAX_SCHEDULE_LINKS)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[1-9][0-9]{0,18}$/u, { each: true })
  supply_ids!: string[];
}
