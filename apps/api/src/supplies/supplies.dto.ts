import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import { ContentAudienceDto } from "../content-audiences/content-audiences.dto.js";
import type { SupplyCategory, SupplyCheckFilter, SupplyListScope } from "./supplies.types.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class ListSuppliesQueryDto {
  @ApiPropertyOptional({
    description: "생략하면 준비물과 숙제를 함께 돌려줍니다.",
    enum: ["general", "homework"],
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["general", "homework"])
  category?: SupplyCategory;

  @ApiPropertyOptional({
    description: "학생 본인의 확인 상태. 생략하면 전체 상태이며 교사는 지정할 수 없습니다.",
    enum: ["unchecked", "modified_unconfirmed", "checked"],
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["unchecked", "modified_unconfirmed", "checked"])
  check_state?: SupplyCheckFilter;

  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiProperty({ enum: ["upcoming", "today", "this_week", "past"] })
  @IsIn(["upcoming", "today", "this_week", "past"])
  scope!: SupplyListScope;

  /** 제목과 내용에서 찾는다. 공백만 넣으면 검색하지 않은 것으로 본다. */
  @ApiPropertyOptional({ description: "제목·내용 검색어", maxLength: 50, type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 50)
  q?: string;
}

export class CreateSupplyDto {
  @ApiPropertyOptional({
    description: "생략하면 게시 시점의 활성 승인 학생 전체를 고정합니다.",
    type: ContentAudienceDto,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @ValidateNested()
  @Type(() => ContentAudienceDto)
  audience?: ContentAudienceDto;

  @ApiPropertyOptional({
    description: "생략하면 일반 준비물로 등록됩니다.",
    enum: ["general", "homework"],
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["general", "homework"])
  category?: SupplyCategory;

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
  needed_on!: string;

  @ApiProperty({ maxLength: 100, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 100)
  @IsPlainText()
  title!: string;
}

export class UpdateSupplyDto {
  @ApiPropertyOptional({ enum: ["general", "homework"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["general", "homework"])
  category?: SupplyCategory;

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
  needed_on?: string;

  @ApiPropertyOptional({
    description:
      "true면 오타·띄어쓰기 수정으로 보고 판을 올리지 않아 학생 재확인을 요구하지 않습니다. 제목·설명에서 바뀐 글자가 5자 이하이고 숫자가 그대로이며 날짜·종류가 그대로일 때만 받습니다.",
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

export class DeleteSupplyDto {
  @ApiProperty({ maxLength: 300, nullable: true, type: String })
  @IsDefined()
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(0, 300)
  @IsPlainText()
  reason!: string | null;
}

export class SetSupplyCheckDto {
  @ApiProperty({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  content_revision!: number;

  @ApiProperty({ type: Boolean })
  @IsBoolean()
  is_checked!: boolean;
}

export class ListSupplyChecksQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiProperty({ enum: ["checked", "unchecked", "modified_unconfirmed"] })
  @IsIn(["checked", "unchecked", "modified_unconfirmed"])
  state!: SupplyCheckFilter;
}
