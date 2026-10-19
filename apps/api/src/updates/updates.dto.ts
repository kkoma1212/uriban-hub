import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsString, ValidateIf } from "class-validator";

import { CodePointLength } from "../common/validation/text-validation.js";
import type { UpdatesFilter } from "./updates.types.js";

export class ListUpdatesQueryDto {
  @ApiPropertyOptional({ description: "이전 응답의 opaque Base64URL 커서", type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    default: "all",
    enum: [
      "all",
      "notices",
      "materials",
      "important",
      "performance",
      "supplies",
      "homework",
      "unresolved",
    ],
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([
    "all",
    "notices",
    "materials",
    "important",
    "performance",
    "supplies",
    "homework",
    "unresolved",
  ])
  filter?: UpdatesFilter;

  /** 공지·준비물의 제목과 본문에서 찾는다. 투표는 대상이 아니다. */
  @ApiPropertyOptional({ description: "제목·본문 검색어", maxLength: 50, type: String })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @CodePointLength(1, 50)
  q?: string;
}
