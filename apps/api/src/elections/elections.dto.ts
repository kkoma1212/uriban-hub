import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Matches } from "class-validator";

import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

const TIE_BREAKS = ["revote", "elder", "teacher_decides"] as const;
const RESULTS_VISIBILITIES = ["winner_only", "with_counts"] as const;

export class CreateElectionDto {
  @ApiProperty({ maxLength: 80, minLength: 1, type: String })
  @Transform(trimText)
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  title!: string;

  /*
   * 동표 처리 방식은 만들 때 정해야 한다. 개표 결과를 보고 고르면 그건 선거가
   * 아니므로, 나중에 바꿀 수 있는 경로를 아예 두지 않는다(DB 트리거가 이중 방어).
   */
  @ApiProperty({ enum: TIE_BREAKS })
  @IsIn(TIE_BREAKS)
  tie_break!: (typeof TIE_BREAKS)[number];

  @ApiProperty({ enum: RESULTS_VISIBILITIES })
  @IsIn(RESULTS_VISIBILITIES)
  results_visibility!: (typeof RESULTS_VISIBILITIES)[number];
}

export class RegisterElectionCandidateDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  @IsString()
  @Matches(/^[1-9][0-9]*$/u)
  member_id!: string;
}

export class PublishElectionDto {
  /** 동점일 때만 필요하다. 동점자 중 하나여야 한다. */
  @ApiPropertyOptional({ pattern: "^[1-9][0-9]*$", type: String })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9][0-9]*$/u)
  winner_candidate_id?: string;
}

export class CastElectionVoteDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  @IsString()
  @Matches(/^[1-9][0-9]*$/u)
  candidate_id!: string;
}
