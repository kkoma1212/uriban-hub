import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsDefined, IsIn, IsString, Matches, ValidateIf } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type { HelpRequestKind, HelpRequestTargetKind } from "./help-requests.types.js";

/** 요청의 첫 설명·처리 완료 답변은 한 줄 수준으로 제한한다. 이어지는 대화는 HELP_MESSAGE_MAX. */
export const HELP_REQUEST_TEXT_MAX = 200;
/** 대화 메시지 한 개의 길이(DB help_request_messages_body_check와 같다). */
export const HELP_MESSAGE_MAX = 500;
const ID_PATTERN = /^[1-9][0-9]{0,18}$/u;

const trimOptionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class ListHelpRequestsQueryDto {
  @ApiPropertyOptional({ default: "open", enum: ["open", "all"] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(["open", "all"])
  status?: "open" | "all";

  @ApiPropertyOptional({ enum: ["notice", "supply"] })
  @ValidateIf((object: ListHelpRequestsQueryDto) => object.target_id !== undefined)
  @IsIn(["notice", "supply"])
  target_kind?: HelpRequestTargetKind;

  @ApiPropertyOptional({ pattern: "^[1-9][0-9]*$", type: String })
  @ValidateIf((object: ListHelpRequestsQueryDto) => object.target_kind !== undefined)
  @IsString()
  @Matches(ID_PATTERN)
  target_id?: string;
}

export class CreateHelpRequestDto {
  @ApiProperty({ enum: ["notice", "supply"] })
  @IsIn(["notice", "supply"])
  target_kind!: HelpRequestTargetKind;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  @IsString()
  @Matches(ID_PATTERN)
  target_id!: string;

  @ApiProperty({ enum: ["question", "hard_to_prepare"] })
  @IsIn(["question", "hard_to_prepare"])
  kind!: Exclude<HelpRequestKind, "general">;

  @ApiProperty({ maxLength: HELP_REQUEST_TEXT_MAX, nullable: true, type: String })
  @IsDefined()
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(1, HELP_REQUEST_TEXT_MAX)
  @IsPlainText()
  message!: string | null;
}

/** 대화 메시지. 앞뒤 공백을 뺀 뒤 1~500자, 줄바꿈은 허용한다. */
export class SendHelpMessageDto {
  @ApiProperty({ maxLength: HELP_MESSAGE_MAX, minLength: 1, type: String })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @CodePointLength(1, HELP_MESSAGE_MAX)
  @IsPlainText({ allowLineFeed: true })
  body!: string;
}

export class ResolveHelpRequestDto {
  @ApiProperty({ maxLength: HELP_REQUEST_TEXT_MAX, nullable: true, type: String })
  @IsDefined()
  @Transform(trimOptionalText)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @CodePointLength(1, HELP_REQUEST_TEXT_MAX)
  @IsPlainText()
  reply!: string | null;
}
