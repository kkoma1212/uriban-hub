import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches } from "class-validator";

export class MonthMealsQueryDto {
  @ApiProperty({
    example: "2026-07",
    pattern: "^(?:20[0-9]{2}|2100)-(?:0[1-9]|1[0-2])$",
    type: String,
  })
  @IsString()
  @Matches(/^(?:20[0-9]{2}|2100)-(?:0[1-9]|1[0-2])$/u)
  month!: string;
}
