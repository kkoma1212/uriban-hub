import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type {
  StudentAssessmentStatus,
  StudentAssessmentType,
} from "./student-assessments.types.js";

const ASSESSMENT_STATUSES: StudentAssessmentStatus[] = ["draft", "recorded"];
const ASSESSMENT_TYPES: StudentAssessmentType[] = ["performance", "written"];

const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class StudentAssessmentWriteDto {
  @ApiPropertyOptional({ maximum: 2100, minimum: 2020, nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(2020)
  @Max(2100)
  academic_year?: number | null;

  @ApiPropertyOptional({
    example: "2026-07-20",
    format: "date",
    nullable: true,
    type: String,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  @IsDateString({ strict: true, strictSeparator: true })
  assessment_date?: string | null;

  @ApiPropertyOptional({ enum: ASSESSMENT_TYPES, nullable: true })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsIn(ASSESSMENT_TYPES)
  assessment_type?: StudentAssessmentType | null;

  @ApiPropertyOptional({ maximum: 100_000, minimum: 1, nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(100_000)
  max_score_hundredths?: number | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(1, 500)
  @IsPlainText({ allowLineFeed: true })
  memo?: string | null;

  @ApiPropertyOptional({ maximum: 100_000, minimum: 0, nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(100_000)
  score_hundredths?: number | null;

  @ApiPropertyOptional({ enum: [1, 2], nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsIn([1, 2])
  semester?: number | null;

  @ApiPropertyOptional({ maxLength: 30, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(1, 30)
  @IsPlainText()
  subject?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true, type: String })
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title?: string | null;

  @ApiPropertyOptional({ maximum: 10_000, minimum: 1, nullable: true, type: Number })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(10_000)
  weight_basis_points?: number | null;
}

export class StudentAssessmentCreateDto extends StudentAssessmentWriteDto {
  @ApiPropertyOptional({ enum: ["personal", "current_class"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["personal", "current_class"])
  connection_scope?: "personal" | "current_class";
  @ApiPropertyOptional({ pattern: "^[1-9][0-9]*$", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[1-9][0-9]*$/u)
  expected_class_id?: string;
}

export class ListStudentAssessmentsQueryDto {
  @ApiPropertyOptional({ maximum: 2100, minimum: 2020, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(2020)
  @Max(2100)
  academic_year?: number;

  @ApiPropertyOptional({ enum: [1, 2], type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([1, 2])
  semester?: number;

  @ApiPropertyOptional({ enum: ASSESSMENT_STATUSES })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(ASSESSMENT_STATUSES)
  status?: StudentAssessmentStatus;
}

export class ExportStudentAssessmentsQueryDto {
  @ApiPropertyOptional({ maximum: 2100, minimum: 2020, type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(2020)
  @Max(2100)
  academic_year?: number;

  @ApiPropertyOptional({ enum: [1, 2], type: Number })
  @Type(() => Number)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([1, 2])
  semester?: number;
}
