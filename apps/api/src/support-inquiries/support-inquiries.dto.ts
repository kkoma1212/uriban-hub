import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

export class CreateSupportInquiryDto {
  @ApiProperty({ maxLength: 200, minLength: 1, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(1, 200)
  @IsPlainText()
  subject!: string;

  @ApiProperty({ maxLength: 10000, minLength: 1, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(1, 10000)
  @IsPlainText({ allowLineFeed: true })
  body!: string;
}
