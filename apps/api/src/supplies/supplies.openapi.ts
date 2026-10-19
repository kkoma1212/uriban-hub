import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import type { SupplyCategory, SupplyCheckState } from "./supplies.types.js";

const CHECK_STATES: SupplyCheckState[] = ["checked", "modified_unconfirmed", "unchecked"];

export class SupplyItemResponseDto {
  @ApiProperty({ enum: ["legacy_class", "all_snapshot", "selected_snapshot"] })
  audience_mode!: ContentAudienceMode;

  @ApiProperty({ enum: ["general", "homework"] })
  category!: SupplyCategory;

  @ApiPropertyOptional({ enum: CHECK_STATES })
  check_state?: SupplyCheckState;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "2026-07-15", format: "date", type: String })
  needed_on!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class SupplyDateRangeResponseDto {
  @ApiProperty({ format: "date", type: String })
  start_date!: string;

  @ApiProperty({ format: "date", type: String })
  end_date!: string;
}

export class SupplyListResponseDto {
  @ApiPropertyOptional({
    type: SupplyDateRangeResponseDto,
    description: "today/this_week에서 서버가 적용한 양끝 포함 KST 조회 기간",
  })
  date_range?: SupplyDateRangeResponseDto;

  @ApiProperty({ type: () => [SupplyItemResponseDto] })
  items!: SupplyItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ type: Boolean })
  selected_audience_enabled!: boolean;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;
}

export class SupplyCheckResponseDto {
  @ApiProperty({ enum: CHECK_STATES })
  check_state!: SupplyCheckState;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  supply_id!: string;
}

export class SupplyCheckMemberResponseDto {
  @ApiProperty({ enum: CHECK_STATES })
  check_state!: SupplyCheckState;

  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  member_id!: string;

  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  student_number!: number | null;
}

export class SupplyCheckCountsResponseDto {
  @ApiProperty({ minimum: 0, type: Number })
  checked!: number;

  @ApiProperty({
    description:
      "게시 이후 승인돼 이 준비물의 대상이 아닌 학생 수. 위 세 집계에는 포함되지 않는다.",
    minimum: 0,
    type: Number,
  })
  excluded_member_count!: number;

  @ApiProperty({ minimum: 0, type: Number })
  modified_unconfirmed!: number;

  @ApiPropertyOptional({
    description:
      "챙김 중 마지막 수정 전부터 체크 기록이 있던 학생 수(수정 뒤 다시 챙김). 재확인율 = reconfirmed / (reconfirmed + modified_unconfirmed).",
    minimum: 0,
    type: Number,
  })
  reconfirmed?: number;

  @ApiProperty({ minimum: 0, type: Number })
  unchecked!: number;
}

export class SupplyChecksResponseDto {
  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ type: SupplyCheckCountsResponseDto })
  counts!: SupplyCheckCountsResponseDto;

  @ApiProperty({ type: () => [SupplyCheckMemberResponseDto] })
  items!: SupplyCheckMemberResponseDto[];

  @ApiProperty({
    example: "2026-07-24T07:00:00.000Z",
    format: "date-time",
    nullable: true,
    type: String,
  })
  last_reminder_requested_at!: string | null;

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;
}
