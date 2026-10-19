import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsString, Matches } from "class-validator";

import { CodePointLength, IsNewPasswordText } from "../common/validation/text-validation.js";

export class AdminLoginRequestDto {
  @ApiProperty({ format: "email", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 1, type: String, writeOnly: true })
  @IsString()
  @CodePointLength(1)
  password!: string;
}

export class AdminTotpRequestDto {
  @ApiProperty({ maxLength: 6, minLength: 6, pattern: "^[0-9]{6}$", writeOnly: true })
  @IsString()
  @Matches(/^\d{6}$/u)
  totp_code!: string;
}

export class AdminStepUpRequestDto extends AdminTotpRequestDto {
  @ApiProperty({ minLength: 1, type: String, writeOnly: true })
  @IsString()
  @CodePointLength(1)
  password!: string;
}

export class AdminChangePasswordRequestDto {
  @ApiProperty({ minLength: 6, type: String, writeOnly: true })
  @IsString()
  @CodePointLength(6)
  @IsNewPasswordText()
  new_password!: string;
}
