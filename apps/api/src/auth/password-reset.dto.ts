import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsString, Matches } from "class-validator";

import { CodePointLength, IsNewPasswordText } from "../common/validation/text-validation.js";

export class PasswordResetRequestDto {
  @ApiProperty({ format: "email", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;
}

export class PasswordResetRequestResponseDto {
  @ApiProperty({ enum: [true], type: Boolean })
  request_accepted!: true;
}

export class ConfirmPasswordResetRequestDto {
  @ApiProperty({ maxLength: 43, minLength: 43, pattern: "^[A-Za-z0-9_-]{43}$", type: String })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/u)
  token!: string;

  @ApiProperty({
    minLength: 6,
    type: String,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.normalize("NFC") : value,
  )
  @IsString()
  @CodePointLength(6)
  @IsNewPasswordText()
  new_password!: string;
}

export class ConfirmPasswordResetResponseDto {
  @ApiProperty({ enum: ["LOGIN"], type: String })
  next_action!: "LOGIN";

  @ApiProperty({ enum: [true], type: Boolean })
  password_reset!: true;
}
