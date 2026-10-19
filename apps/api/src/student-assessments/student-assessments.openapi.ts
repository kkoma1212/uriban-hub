import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import type {
  StudentAssessmentItem,
  StudentAssessmentListResult,
  StudentAssessmentStatus,
  StudentAssessmentType,
} from "./student-assessments.types.js";

export class StudentAssessmentItemResponseDto implements StudentAssessmentItem {
  @ApiPropertyOptional({ enum: ["personal", "current_class"] })
  connection_scope?: "personal" | "current_class";
  @ApiPropertyOptional({ nullable: true, type: String })
  class_id?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  class_name?: string | null;
  @ApiProperty({ maximum: 2100, minimum: 2020, nullable: true, type: Number })
  academic_year!: number | null;

  @ApiProperty({ format: "date", nullable: true, type: String })
  assessment_date!: string | null;

  @ApiProperty({ enum: ["performance", "written"], nullable: true })
  assessment_type!: StudentAssessmentType | null;

  @ApiProperty({ format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ format: "date-time", type: String })
  expires_at!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ maximum: 100_000, minimum: 1, nullable: true, type: Number })
  max_score_hundredths!: number | null;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  memo!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  recorded_at!: string | null;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ maximum: 100_000, minimum: 0, nullable: true, type: Number })
  score_hundredths!: number | null;

  @ApiProperty({ enum: [1, 2], nullable: true, type: Number })
  semester!: number | null;

  @ApiProperty({ enum: ["draft", "recorded"] })
  status!: StudentAssessmentStatus;

  @ApiProperty({ maxLength: 30, nullable: true, type: String })
  subject!: string | null;

  @ApiProperty({ maxLength: 100, nullable: true, type: String })
  title!: string | null;

  @ApiProperty({ format: "date-time", type: String })
  updated_at!: string;

  @ApiProperty({ maximum: 10_000, minimum: 1, nullable: true, type: Number })
  weight_basis_points!: number | null;
}

export class StudentAssessmentListResponseDto implements StudentAssessmentListResult {
  @ApiProperty({ type: () => [StudentAssessmentItemResponseDto] })
  items!: StudentAssessmentItem[];

  @ApiProperty({ example: "2026-07-30", format: "date", type: String })
  server_today!: string;
}

export class StudentAssessmentCurrentClassResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) name!: string;
}
export class StudentAssessmentCreationContextResponseDto {
  @ApiProperty({ type: Boolean }) class_connection_available!: boolean;
  @ApiProperty({ nullable: true, type: () => StudentAssessmentCurrentClassResponseDto })
  current_class!: StudentAssessmentCurrentClassResponseDto | null;
}
