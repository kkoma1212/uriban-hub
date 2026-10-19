import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import { PROFILE_PHOTO_MAX_BASE64_LENGTH } from "./profile-photo.constants.js";

export class UpdateProfilePhotoRequestDto {
  @ApiProperty({
    description: "512KiB 이하 JPG·PNG·WebP의 base64 본문(data URL 접두어 제외)",
    maxLength: PROFILE_PHOTO_MAX_BASE64_LENGTH,
  })
  @IsString()
  @MinLength(4)
  @MaxLength(PROFILE_PHOTO_MAX_BASE64_LENGTH)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/u)
  image_base64!: string;
}
