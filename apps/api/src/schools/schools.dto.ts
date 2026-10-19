import { Transform } from "class-transformer";
import { IsString } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

export class SearchSchoolsQueryDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(2, 100)
  @IsPlainText()
  q!: string;
}
