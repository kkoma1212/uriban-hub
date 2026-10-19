import { Transform } from "class-transformer";
import { IsBoolean, IsEmail, IsString, Length, Matches } from "class-validator";

import {
  CodePointLength,
  IsNewPasswordText,
  IsPlainText,
} from "../common/validation/text-validation.js";

export class LocalAdminLoginDto {
  @IsString()
  @CodePointLength(1)
  password!: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 50)
  username!: string;
}

export class CreateLocalTestAccountDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(2, 20)
  @IsPlainText()
  display_name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @Matches(/@example\.com$/u)
  email!: string;

  @IsBoolean()
  email_verified!: boolean;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.normalize("NFC") : value,
  )
  @IsString()
  @CodePointLength(6)
  @IsNewPasswordText()
  password!: string;
}

export class DeleteLocalTestAccountDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @Matches(/@example\.com$/u)
  email!: string;
}
