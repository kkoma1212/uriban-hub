import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsInt, IsString, Matches, Max, Min, ValidateIf } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type { CurrentClassResult } from "./classes.types.js";

export class ArchiveCurrentClassDto {
  @ApiProperty({
    description: "현재 반 표시명을 공백과 대소문자까지 정확히 재입력",
    maxLength: 40,
    minLength: 1,
    type: String,
  })
  @IsString()
  @CodePointLength(1, 40)
  @IsPlainText()
  class_name_confirmation!: string;

  @ApiProperty({
    description: "종료 화면에서 확인한 반 ID",
    pattern: "^[1-9][0-9]{0,18}$",
    type: String,
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/u)
  expected_class_id!: string;

  @ApiProperty({
    description: "종료 화면에서 확인한 반 버전",
    pattern: "^[1-9][0-9]{0,18}$",
    type: String,
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/u)
  expected_row_version!: string;
}

export class ArchiveCurrentClassResponseDto {
  @ApiProperty({ format: "date-time", type: String })
  archived_at!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  class_id!: string;

  @ApiProperty({ enum: ["CREATE_CLASS"], type: String })
  next_action!: "CREATE_CLASS";

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;
}

export class CurrentClassResponseDto implements CurrentClassResult {
  @ApiProperty({ maximum: 2100, minimum: 2020, type: Number })
  academic_year!: number;

  @ApiProperty({ minimum: 0, type: Number })
  active_student_count!: number;

  @ApiPropertyOptional({ maximum: 60, minimum: 1, type: Number })
  expected_student_count?: number;

  @ApiProperty({ maximum: 6, minimum: 1, type: Number })
  grade!: number;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ maxLength: 40, type: String })
  name!: string;

  @ApiProperty({ enum: ["student", "teacher"], type: String })
  role!: "student" | "teacher";

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ maxLength: 401, nullable: true, type: String })
  school_address!: string | null;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  school_homepage_url!: string | null;

  @ApiProperty({ maxLength: 100, type: String })
  school_name!: string;

  @ApiProperty({ maxLength: 50, nullable: true, type: String })
  school_phone_number!: string | null;

  @ApiProperty({ enum: ["active"], type: String })
  status!: "active";

  @ApiProperty({ maxLength: 20, type: String })
  teacher_display_name!: string;
}

export class CreateClassDto {
  @ApiProperty({ maximum: 2100, minimum: 2020, type: Number })
  @IsInt()
  @Min(2020)
  @Max(2100)
  academic_year!: number;

  @ApiProperty({ pattern: "^[A-Z][0-9]{2}$", type: String })
  @Matches(/^[A-Z][0-9]{2}$/u)
  edu_office_code!: string;

  @ApiProperty({ maximum: 60, minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  @Max(60)
  expected_student_count!: number;

  @ApiProperty({ maximum: 6, minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  @Max(6)
  grade!: number;

  @ApiProperty({ maxLength: 40, minLength: 1, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(1, 40)
  @IsPlainText()
  name!: string;

  @ApiProperty({ pattern: "^[0-9]{7}$", type: String })
  @Matches(/^[0-9]{7}$/u)
  school_code!: string;
}

export class UpdateCurrentClassDto {
  @ApiPropertyOptional({ maximum: 60, minimum: 1, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(60)
  expected_student_count!: number | undefined;

  @ApiPropertyOptional({ maxLength: 40, minLength: 1, type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(1, 40)
  @IsPlainText()
  name!: string | undefined;
}
