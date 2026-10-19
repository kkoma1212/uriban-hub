import { ApiProperty } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { LegalConsentSnapshotDto } from "../legal/legal-consent.dto.js";
import {
  Equals,
  IsDefined,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import {
  CodePointLength,
  IsNewPasswordText,
  IsPlainText,
} from "../common/validation/text-validation.js";
import { IsAllowedDisplayName } from "../common/validation/display-name-policy.js";

export class SignUpResponseDto {
  @ApiProperty({ enum: ["LOGIN"], type: String })
  next_action!: "LOGIN";

  @ApiProperty({ enum: [true], type: Boolean })
  request_accepted!: true;
}

export class SignUpConsentsDto {
  @ApiProperty({ enum: [true], type: Boolean })
  @Equals(true)
  privacy!: true;

  @ApiProperty({ enum: [true], type: Boolean })
  @Equals(true)
  terms!: true;
}

export class GuardianConsentReferenceDto {
  @ApiProperty({ format: "uuid", type: String })
  @IsUUID("4")
  request_id!: string;

  @ApiProperty({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{43}$",
    type: String,
    writeOnly: true,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/u)
  completion_token!: string;
}

export class SignUpOptionsResponseDto {
  @ApiProperty({
    description: "true면 가입 화면에서 생년월일을 (선택으로) 받을 수 있습니다.",
    type: Boolean,
  })
  birth_date_collected!: boolean;

  @ApiProperty({
    description: "2026-10-02부터 항상 false(생년월일은 선택). 예전 화면 호환용.",
    type: Boolean,
  })
  birth_date_required!: boolean;

  @ApiProperty({
    description: "false면 만 14세 미만(보호자 동의) 새 가입을 받지 않습니다(시범 운영 P-021).",
    type: Boolean,
  })
  under_14_signup!: boolean;
}

export class SignUpRequestDto {
  @ApiProperty({
    required: false,
    type: () => LegalConsentSnapshotDto,
    description: "게시 문서 결속이 활성화된 환경에서는 필수입니다.",
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => LegalConsentSnapshotDto)
  legal_documents?: LegalConsentSnapshotDto;
  @ApiProperty({
    deprecated: true,
    required: false,
    maxLength: 6,
    minLength: 6,
    pattern: "^[0-9]{6}$",
    type: String,
    writeOnly: true,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{6}$/u)
  approval_code?: string;

  @ApiProperty({ enum: ["over_14", "guardian_consent"], type: String })
  @IsIn(["over_14", "guardian_consent"])
  age_route!: "guardian_consent" | "over_14";

  @ApiProperty({
    required: false,
    format: "date",
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    type: String,
    description: "생년월일 칸이 설치된 환경에서는 필수이고 age_route와 맞아야 합니다.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
  birth_date?: string;

  @ApiProperty({ type: () => SignUpConsentsDto })
  @ValidateNested()
  @Type(() => SignUpConsentsDto)
  @IsObject()
  @IsDefined()
  consents!: SignUpConsentsDto;

  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(2, 20)
  @IsPlainText()
  @IsAllowedDisplayName()
  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({ format: "email", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @ApiProperty({ required: false, type: () => GuardianConsentReferenceDto })
  @ValidateIf(
    (value: SignUpRequestDto) =>
      value.age_route === "guardian_consent" || value.guardian_consent !== undefined,
  )
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => GuardianConsentReferenceDto)
  guardian_consent?: GuardianConsentReferenceDto;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.normalize("NFC") : value,
  )
  @IsString()
  @CodePointLength(6)
  @IsNewPasswordText()
  @ApiProperty({
    description:
      "NFC 정규화 뒤 6자 이상, 길이 상한 없음. 문자와 숫자를 모두 포함. 한글·공백·기호 허용.",
    minLength: 6,
    type: String,
    writeOnly: true,
  })
  password!: string;

  @ApiProperty({ enum: ["teacher", "student"], type: String })
  @IsIn(["teacher", "student"])
  role!: "student" | "teacher";
}

export class GuardianConsentRequestDto {
  @ApiProperty({ required: false, type: () => LegalConsentSnapshotDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => LegalConsentSnapshotDto)
  legal_documents?: LegalConsentSnapshotDto;
  @ApiProperty({ format: "email", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  guardian_email!: string;
}

export class ConfirmGuardianConsentRequestDto {
  @ApiProperty({ required: false, type: () => LegalConsentSnapshotDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => LegalConsentSnapshotDto)
  legal_documents?: LegalConsentSnapshotDto;
  @ApiProperty({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{43}$",
    type: String,
    writeOnly: true,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/u)
  token!: string;
}

export class GuardianConsentStatusRequestDto extends GuardianConsentReferenceDto {}

export class ConfirmEmailRequestDto {
  @ApiProperty({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{43}$",
    type: String,
    writeOnly: true,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/u)
  token!: string;
}

export class LoginRequestDto {
  @ApiProperty({ format: "email", type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @IsString()
  @CodePointLength(1)
  @ApiProperty({ minLength: 1, type: String, writeOnly: true })
  password!: string;
}
