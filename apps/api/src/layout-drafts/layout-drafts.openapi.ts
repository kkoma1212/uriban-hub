import { ApiProperty } from "@nestjs/swagger";

import { LAYOUT_DRAFT_KINDS } from "./layout-drafts.types.js";

export class LayoutDraftItemResponseDto {
  @ApiProperty({ enum: LAYOUT_DRAFT_KINDS })
  kind!: string;

  @ApiProperty({
    additionalProperties: true,
    description: "마법사가 들고 있던 상태. 서버는 해석하지 않고 그대로 돌려준다.",
    type: Object,
  })
  payload!: unknown;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ format: "date-time", type: String })
  updated_at!: string;
}
