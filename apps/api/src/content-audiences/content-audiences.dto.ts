import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsString,
  Matches,
  ValidateIf,
} from "class-validator";

export class ContentAudienceDto {
  @ApiPropertyOptional({
    description: "mode=selected일 때 게시 시점에 고정할 같은 반 학생 멤버 ID",
    isArray: true,
    maxItems: 60,
    minItems: 1,
    type: String,
  })
  @ValidateIf((audience: ContentAudienceDto) => audience.mode === "selected")
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @Matches(/^[1-9][0-9]*$/u, { each: true })
  member_ids?: string[];

  @ApiProperty({ enum: ["all", "selected"] })
  @IsIn(["all", "selected"])
  mode!: "all" | "selected";
}
