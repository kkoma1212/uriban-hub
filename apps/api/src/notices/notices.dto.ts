import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import { ContentAudienceDto } from "../content-audiences/content-audiences.dto.js";
import type {
  NoticeCategory,
  NoticeConfirmationFilter,
  NoticeImportance,
} from "./notices.types.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class ListNoticesQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: "all", enum: ["all", "important", "regular"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["all", "important", "regular"])
  importance?: NoticeImportance;

  /** 제목과 본문에서 찾는다. 공백만 넣으면 검색하지 않은 것으로 본다. */
  @ApiPropertyOptional({ description: "제목·본문 검색어", maxLength: 50, type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 50)
  q?: string;
}

export class CreateNoticeDto {
  @ApiPropertyOptional({
    description: "생략하면 게시 시점의 활성 승인 학생 전체를 고정합니다.",
    type: ContentAudienceDto,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @ValidateNested()
  @Type(() => ContentAudienceDto)
  audience?: ContentAudienceDto;

  @ApiPropertyOptional({ default: "general", enum: ["general", "performance"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["general", "performance"])
  category?: NoticeCategory;

  @ApiProperty({ maxLength: 2000, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 2000)
  @IsPlainText({ allowLineFeed: true })
  content!: string;

  @ApiPropertyOptional({ default: false, type: Boolean })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  is_important?: boolean;

  @ApiProperty({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title!: string;
}

export class UpdateNoticeDto {
  @ApiPropertyOptional({ enum: ["general", "performance"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["general", "performance"])
  category?: NoticeCategory;

  @ApiPropertyOptional({ maxLength: 2000, minLength: 1, type: String })
  @Transform(trimText)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 2000)
  @IsPlainText({ allowLineFeed: true })
  content?: string;

  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  is_important?: boolean;

  @ApiPropertyOptional({
    description:
      "true면 오타·띄어쓰기 수정으로 보고 판을 올리지 않아 학생 재확인을 요구하지 않습니다. 제목·본문에서 바뀐 글자가 5자 이하이고 숫자가 그대로일 때만 받습니다.",
    type: Boolean,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  minor_edit?: boolean;

  @ApiPropertyOptional({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title?: string;
}

export class DeleteNoticeDto {
  @ApiProperty({ maxLength: 300, nullable: true, type: String })
  @IsDefined()
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(0, 300)
  @IsPlainText()
  reason!: string | null;
}

export class ConfirmNoticeDto {
  @ApiProperty({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  content_revision!: number;
}

export class ListNoticeConfirmationsQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiProperty({ enum: ["confirmed", "unread", "modified_unconfirmed"] })
  @IsIn(["confirmed", "unread", "modified_unconfirmed"])
  state!: NoticeConfirmationFilter;
}
