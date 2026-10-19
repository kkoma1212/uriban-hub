import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import type { NoticeConfirmationState } from "../notices/notices.types.js";
import type { SupplyCheckState } from "../supplies/supplies.types.js";
import type { UpdateItemCategory, UpdateItemKind } from "./updates.types.js";

export class UpdateItemResponseDto {
  @ApiProperty({ enum: ["legacy_class", "all_snapshot", "selected_snapshot"] })
  audience_mode!: ContentAudienceMode;

  @ApiProperty({ enum: ["general", "performance", "homework"] })
  category!: UpdateItemCategory;

  @ApiPropertyOptional({ enum: ["checked", "modified_unconfirmed", "unchecked"] })
  check_state?: SupplyCheckState;

  @ApiPropertyOptional({ enum: ["confirmed", "modified_unconfirmed", "unread"] })
  confirmation_state?: NoticeConfirmationState;

  @ApiProperty({ maxLength: 2000, nullable: true, type: String })
  content!: string | null;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ type: Boolean })
  is_important!: boolean;

  @ApiProperty({ enum: ["notice", "supply"] })
  kind!: UpdateItemKind;

  @ApiProperty({ example: "2026-07-28", format: "date", nullable: true, type: String })
  needed_on!: string | null;

  @ApiProperty({ example: "2026-07-26T04:05:06.123456Z", format: "date-time", type: String })
  published_at!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class UpdatesListResponseDto {
  @ApiPropertyOptional({
    description:
      "학생 본인에게 보이는 소식 중 최신 내용을 아직 확인하거나 챙기지 않은 수. 검색·선택 필터와 무관하며 기존 소식 범위(준비물 최근 90일)를 따른다. 교사는 null.",
    minimum: 0,
    nullable: true,
    type: Number,
  })
  unresolved_count?: number | null;

  @ApiProperty({ type: () => [UpdateItemResponseDto] })
  items!: UpdateItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ type: Boolean })
  selected_audience_enabled!: boolean;

  @ApiProperty({ example: "2026-07-26", format: "date", type: String })
  server_today!: string;
}
