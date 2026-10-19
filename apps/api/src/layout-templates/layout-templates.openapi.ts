import { ApiProperty } from "@nestjs/swagger";

import type { LayoutTemplateItem, LayoutTemplateListResult } from "./layout-templates.types.js";

export class LayoutTemplateItemResponseDto implements LayoutTemplateItem {
  @ApiProperty({ format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ maxLength: 40, minLength: 1, type: String })
  name!: string;

  @ApiProperty({
    additionalProperties: true,
    description: "마법사 1단계가 들고 있던 교실 배치. 서버는 해석하지 않고 그대로 돌려준다.",
    type: Object,
  })
  payload!: unknown;

  @ApiProperty({ format: "date-time", type: String })
  updated_at!: string;
}

export class LayoutTemplateListResponseDto implements LayoutTemplateListResult {
  @ApiProperty({ type: () => [LayoutTemplateItemResponseDto] })
  items!: LayoutTemplateItemResponseDto[];
}
