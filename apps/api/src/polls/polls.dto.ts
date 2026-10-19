import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsString,
  Matches,
  ValidateIf,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type { PollBallotVisibility, PollListScope, PollResultsPolicy } from "./polls.types.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const trimOptions = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((option) => (typeof option === "string" ? option.trim() : option))
    : value;

export class ListPollsQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiProperty({ enum: ["open", "closed"] })
  @IsIn(["open", "closed"])
  scope!: PollListScope;
}

export class CreatePollDto {
  @ApiPropertyOptional({
    description: "미지정 시 private",
    enum: ["private", "teacher_visible"],
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["private", "teacher_visible"])
  ballot_visibility?: PollBallotVisibility;

  @ApiProperty({ example: "2026-08-01T09:00:00.000Z", format: "date-time", type: String })
  @IsString()
  @IsDateString({ strict: true })
  closes_at!: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(1, 500)
  @IsPlainText({ allowLineFeed: true })
  description?: string | null;

  @ApiProperty({
    example: ["창가부터", "복도부터"],
    isArray: true,
    maxItems: 10,
    minItems: 2,
    type: String,
  })
  @Transform(trimOptions)
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @CodePointLength(1, 80, { each: true })
  @IsPlainText({}, { each: true })
  options!: string[];

  @ApiPropertyOptional({
    description: "미지정 시 after_vote",
    enum: ["after_vote", "after_close", "teacher_only"],
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["after_vote", "after_close", "teacher_only"])
  results_policy?: PollResultsPolicy;

  @ApiProperty({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title!: string;
}

/** 진행 중 투표 수정(제한형). 공개 설정은 받지 않는다 — 보내면 검증 단계에서 거부된다. */
export class UpdatePollDto {
  @ApiProperty({ example: "2026-08-01T09:00:00.000Z", format: "date-time", type: String })
  @IsString()
  @IsDateString({ strict: true })
  closes_at!: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(1, 500)
  @IsPlainText({ allowLineFeed: true })
  description?: string | null;

  @ApiProperty({
    description: "참여한 학생이 있으면 지금 선택지와 똑같아야 한다(POLL_OPTIONS_LOCKED)",
    example: ["창가부터", "복도부터"],
    isArray: true,
    maxItems: 10,
    minItems: 2,
    type: String,
  })
  @Transform(trimOptions)
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @CodePointLength(1, 80, { each: true })
  @IsPlainText({}, { each: true })
  options!: string[];

  @ApiProperty({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title!: string;
}

export class VoteInPollDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  @IsString()
  @Matches(/^[1-9][0-9]*$/u)
  option_id!: string;
}
