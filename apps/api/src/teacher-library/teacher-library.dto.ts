import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  Equals,
  IsDefined,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

export type TeacherLibraryKind = "notice" | "supply";
const ID_PATTERN = /^[1-9][0-9]{0,18}$/u;

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;
const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** 담기 전 확인: 교사가 고친 제목·본문을 원글 반의 학생 이름·연락처 모양과 대조한다. */
export class CheckTeacherLibraryItemDto {
  @ApiProperty({ enum: ["notice", "supply"] })
  @IsIn(["notice", "supply"])
  kind!: TeacherLibraryKind;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  @IsString()
  @Matches(ID_PATTERN)
  source_id!: string;

  @ApiProperty({ maxLength: 100, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title!: string;

  @ApiProperty({ maxLength: 2000, nullable: true, type: String })
  @IsDefined()
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(1, 2000)
  body!: string | null;
}

export class CreateTeacherLibraryItemDto extends CheckTeacherLibraryItemDto {
  /** 교사가 '학생 개인정보가 없음'을 직접 확인해야 저장된다. */
  @ApiProperty({ enum: [true], type: Boolean })
  @Equals(true)
  confirm_personal_info!: true;
}

export class ListTeacherLibraryQueryDto {
  @ApiPropertyOptional({ enum: ["notice", "supply"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["notice", "supply"])
  kind?: TeacherLibraryKind;

  @ApiPropertyOptional({ maximum: 2100, minimum: 2020, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" && /^\d{4}$/u.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(2020)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ description: "제목·본문 검색어", maxLength: 50, type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 50)
  q?: string;

  @ApiPropertyOptional({ description: "이전 응답의 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/u)
  cursor?: string;
}
