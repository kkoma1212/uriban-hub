import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import type { NoticeCategory, NoticeConfirmationState } from "./notices.types.js";

const CONFIRMATION_STATES: NoticeConfirmationState[] = [
  "confirmed",
  "modified_unconfirmed",
  "unread",
];

export class NoticeItemResponseDto {
  @ApiProperty({ enum: ["legacy_class", "all_snapshot", "selected_snapshot"] })
  audience_mode!: ContentAudienceMode;

  @ApiProperty({ enum: ["general", "performance"] })
  category!: NoticeCategory;

  @ApiPropertyOptional({ enum: CONFIRMATION_STATES })
  confirmation_state?: NoticeConfirmationState;

  @ApiProperty({ maxLength: 2000, type: String })
  content!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ type: Boolean })
  is_important!: boolean;

  @ApiProperty({ example: "2026-07-14T03:00:00.000Z", format: "date-time", type: String })
  published_at!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class NoticeListResponseDto {
  @ApiProperty({ type: () => [NoticeItemResponseDto] })
  items!: NoticeItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ type: Boolean })
  selected_audience_enabled!: boolean;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;
}

export class NoticeConfirmationResponseDto {
  @ApiProperty({ enum: ["confirmed"] })
  confirmation_state!: "confirmed";

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  notice_id!: string;
}

export class NoticeConfirmationMemberResponseDto {
  @ApiProperty({ enum: CONFIRMATION_STATES })
  confirmation_state!: NoticeConfirmationState;

  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  member_id!: string;

  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  student_number!: number | null;
}

export class NoticeConfirmationCountsResponseDto {
  @ApiProperty({ minimum: 0, type: Number })
  confirmed!: number;

  @ApiProperty({
    description: "게시 이후 승인돼 이 공지의 대상이 아닌 학생 수. 위 세 집계에는 포함되지 않는다.",
    minimum: 0,
    type: Number,
  })
  excluded_member_count!: number;

  @ApiProperty({ minimum: 0, type: Number })
  modified_unconfirmed!: number;

  @ApiPropertyOptional({
    description:
      "확인함 중 수정 뒤 새 내용을 다시 확인한 학생 수(확인 현황 응답에만 있음). 재확인율 = reconfirmed / (reconfirmed + modified_unconfirmed).",
    minimum: 0,
    type: Number,
  })
  reconfirmed?: number;

  @ApiProperty({ minimum: 0, type: Number })
  unread!: number;
}

export class NoticeConfirmationsResponseDto {
  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ type: NoticeConfirmationCountsResponseDto })
  counts!: NoticeConfirmationCountsResponseDto;

  @ApiProperty({ type: () => [NoticeConfirmationMemberResponseDto] })
  items!: NoticeConfirmationMemberResponseDto[];

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
