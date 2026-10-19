import { ADMIN_ROLES, type AdminRole } from "@classhub/db";
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsString,
  MaxLength,
} from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export const ADMIN_ACCOUNT_MUTABLE_STATUSES = ["active", "suspended", "revoked"] as const;
export type AdminAccountMutableStatus = (typeof ADMIN_ACCOUNT_MUTABLE_STATUSES)[number];

export class CreateAdminAccountDto {
  @ApiProperty({ format: "email", maxLength: 320, type: String })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ maxLength: 40, minLength: 2, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(2, 40)
  @IsPlainText()
  display_name!: string;

  @ApiProperty({ enum: ADMIN_ROLES, isArray: true, minItems: 1, uniqueItems: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(ADMIN_ROLES, { each: true })
  roles!: AdminRole[];
}

export class UpdateAdminAccountStatusDto {
  @ApiProperty({ enum: ADMIN_ACCOUNT_MUTABLE_STATUSES, type: String })
  @IsIn(ADMIN_ACCOUNT_MUTABLE_STATUSES)
  status!: AdminAccountMutableStatus;

  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}

export class ReplaceAdminAccountRolesDto {
  @ApiProperty({ enum: ADMIN_ROLES, isArray: true, minItems: 1, uniqueItems: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(ADMIN_ROLES, { each: true })
  roles!: AdminRole[];

  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}

export class AdminAccountRecoveryDto {
  @ApiProperty({ maxLength: 300, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 300)
  @IsPlainText()
  reason!: string;
}
