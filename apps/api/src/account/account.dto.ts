import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Equals, IsString } from "class-validator";

import {
  CodePointLength,
  IsNewPasswordText,
  IsPlainText,
} from "../common/validation/text-validation.js";
import { IsAllowedDisplayName } from "../common/validation/display-name-policy.js";

export class UpdateAccountProfileRequestDto {
  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(2, 20)
  @IsPlainText()
  @IsAllowedDisplayName()
  display_name!: string;
}

export class UpdateAccountProfileResponseDto {
  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({ type: Boolean })
  profile_updated!: boolean;

  @ApiProperty({ format: "date-time", type: String })
  updated_at!: string;
}

export class ChangePasswordRequestDto {
  @ApiProperty({ minLength: 1, type: String })
  @IsString()
  @CodePointLength(1)
  current_password!: string;

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

export class ChangePasswordResponseDto {
  @ApiProperty({ enum: ["LOGIN"], type: String })
  next_action!: "LOGIN";

  @ApiProperty({ enum: [true], type: Boolean })
  password_changed!: true;
}

export class DeleteAccountRequestDto {
  @ApiProperty({ minLength: 1, type: String })
  @IsString()
  @CodePointLength(1)
  current_password!: string;

  @ApiProperty({ enum: ["탈퇴"], type: String })
  @IsString()
  @Equals("탈퇴")
  confirmation!: "탈퇴";
}

export class DeleteAccountResponseDto {
  @ApiProperty({ enum: [true], type: Boolean })
  account_deleted!: true;

  @ApiProperty({ enum: ["LOGIN"], type: String })
  next_action!: "LOGIN";
}
