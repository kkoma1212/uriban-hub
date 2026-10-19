import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsString, Matches, ValidateIf } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type { ClassChatMuteDuration } from "./class-chat.types.js";

/** 메시지 한 개의 길이(DB class_chat_messages_body_check와 같다). */
export const CLASS_CHAT_MESSAGE_MAX = 500;
/** 신고 사유 길이(DB class_chat_reports_reason_check와 같다). */
export const CLASS_CHAT_REPORT_REASON_MAX = 200;
const ID_PATTERN = /^[1-9][0-9]{0,18}$/u;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export class ClassChatStateQueryDto {
  @ApiPropertyOptional({
    description: "이 번호 뒤의 메시지만",
    pattern: "^[1-9][0-9]*$",
    type: String,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(ID_PATTERN)
  after?: string;
}

/** 메시지. 앞뒤 공백을 뺀 뒤 1~500자, 줄바꿈은 허용한다. */
export class SendClassChatMessageDto {
  @ApiProperty({ maxLength: CLASS_CHAT_MESSAGE_MAX, minLength: 1, type: String })
  @Transform(trim)
  @IsString()
  @CodePointLength(1, CLASS_CHAT_MESSAGE_MAX)
  @IsPlainText({ allowLineFeed: true })
  body!: string;
}

export class ReportClassChatMessageDto {
  @ApiProperty({ maxLength: CLASS_CHAT_REPORT_REASON_MAX, minLength: 1, type: String })
  @Transform(trim)
  @IsString()
  @CodePointLength(1, CLASS_CHAT_REPORT_REASON_MAX)
  @IsPlainText()
  reason!: string;
}

export class UpdateClassChatRoomDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  is_open!: boolean;
}

export class MuteClassChatMemberDto {
  @ApiProperty({ enum: ["10m", "1h", "today"] })
  @IsIn(["10m", "1h", "today"])
  duration!: ClassChatMuteDuration;
}
