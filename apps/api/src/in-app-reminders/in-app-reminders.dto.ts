import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";

export class CreateInAppReminderDto {
  @ApiProperty({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  content_revision!: number;
}
