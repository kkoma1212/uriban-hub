import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Matches } from "class-validator";

export class CreateMembershipRequestDto {
  @ApiProperty({ maxLength: 8, minLength: 8, pattern: "^[A-HJ-KM-NP-Z2-9]{8}$", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-HJ-KM-NP-Z2-9]{8}$/u)
  invite_code!: string;
}
