import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail } from "class-validator";

export class AccountRecoveryRequestDto {
  @ApiProperty({ format: "email", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;
}

export class AccountRecoveryResponseDto {
  @ApiProperty({ enum: [true], type: Boolean })
  request_accepted!: true;
}
