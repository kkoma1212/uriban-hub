import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDefined, IsObject, IsString, Matches, MaxLength, ValidateNested } from "class-validator";

import { MAX_PUSH_ENDPOINT_LENGTH } from "./push-endpoint-policy.js";

// 브라우저 PushSubscription.toJSON()의 keys: P-256 공개키 65바이트, 인증값 16바이트(base64url).
export class PushSubscriptionKeysDto {
  @ApiProperty({ pattern: "^[A-Za-z0-9_-]{87}$", type: String })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{87}$/u)
  p256dh!: string;

  @ApiProperty({ pattern: "^[A-Za-z0-9_-]{22}$", type: String })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{22}$/u)
  auth!: string;
}

export class SavePushSubscriptionDto {
  @ApiProperty({ format: "uri", maxLength: MAX_PUSH_ENDPOINT_LENGTH, type: String })
  @IsString()
  @MaxLength(MAX_PUSH_ENDPOINT_LENGTH)
  endpoint!: string;

  @ApiProperty({ type: () => PushSubscriptionKeysDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;
}

export class RemovePushSubscriptionDto {
  @ApiProperty({ format: "uri", maxLength: MAX_PUSH_ENDPOINT_LENGTH, type: String })
  @IsString()
  @MaxLength(MAX_PUSH_ENDPOINT_LENGTH)
  endpoint!: string;
}
