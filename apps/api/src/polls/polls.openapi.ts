import { ApiProperty } from "@nestjs/swagger";

import type {
  PollItem,
  PollBallotVisibility,
  PollListScope,
  PollOptionItem,
  PollParticipantItem,
  PollParticipationResult,
  PollResultsPolicy,
  PollStatus,
} from "./polls.types.js";

const POSITIVE_BIGINT_PATTERN = "^[1-9][0-9]*$";

export class PollOptionResponseDto implements PollOptionItem {
  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  id!: string;

  @ApiProperty({ maxLength: 80, type: String })
  label!: string;

  @ApiProperty({ maximum: 10, minimum: 1, type: Number })
  position!: number;

  @ApiProperty({
    description: "결과 공개 전에는 null",
    minimum: 0,
    nullable: true,
    type: Number,
  })
  vote_count!: number | null;
}

export class PollItemResponseDto implements PollItem {
  @ApiProperty({ enum: ["private", "teacher_visible"] })
  ballot_visibility!: PollBallotVisibility;

  @ApiProperty({
    description: "교사가 직접 종료한 시각. 자동 마감은 null",
    format: "date-time",
    nullable: true,
    type: String,
  })
  closed_at!: string | null;

  @ApiProperty({ format: "date-time", type: String })
  closes_at!: string;

  @ApiProperty({ format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ type: Boolean })
  has_voted!: boolean;

  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  id!: string;

  @ApiProperty({ nullable: true, pattern: POSITIVE_BIGINT_PATTERN, type: String })
  my_option_id!: string | null;

  @ApiProperty({ type: () => [PollOptionResponseDto] })
  options!: PollOptionResponseDto[];

  @ApiProperty({ enum: ["after_vote", "after_close", "teacher_only"] })
  results_policy!: PollResultsPolicy;

  @ApiProperty({ type: Boolean })
  results_visible!: boolean;

  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  row_version!: string;

  @ApiProperty({ enum: ["open", "closed"] })
  status!: PollStatus;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;

  @ApiProperty({
    description: "결과 공개 전에는 null",
    minimum: 0,
    nullable: true,
    type: Number,
  })
  total_vote_count!: number | null;
}

export class PollListResponseDto {
  @ApiProperty({ type: () => [PollItemResponseDto] })
  items!: PollItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ enum: ["open", "closed"] })
  scope!: PollListScope;

  @ApiProperty({ format: "date-time", type: String })
  server_now!: string;
}

export class PollParticipantResponseDto implements PollParticipantItem {
  @ApiProperty({ maxLength: 20, minLength: 2, type: String })
  display_name!: string;

  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  member_id!: string;

  @ApiProperty({
    description: "기명 투표의 참여 현황에서만 담임 교사에게 반환",
    pattern: POSITIVE_BIGINT_PATTERN,
    required: false,
    type: String,
  })
  selected_option_id?: string;

  @ApiProperty({
    description: "기명 투표의 참여 현황에서만 담임 교사에게 반환",
    maxLength: 80,
    required: false,
    type: String,
  })
  selected_option_label?: string;

  @ApiProperty({ maximum: 99, minimum: 1, nullable: true, type: Number })
  student_number!: number | null;
}

export class PollParticipationResponseDto implements PollParticipationResult {
  @ApiProperty({ enum: ["private", "teacher_visible"] })
  ballot_visibility!: PollBallotVisibility;

  @ApiProperty({ pattern: POSITIVE_BIGINT_PATTERN, type: String })
  poll_id!: string;

  @ApiProperty({ minimum: 0, type: Number })
  total_students!: number;

  @ApiProperty({ minimum: 0, type: Number })
  unvoted_count!: number;

  @ApiProperty({ type: () => [PollParticipantResponseDto] })
  unvoted_students!: PollParticipantResponseDto[];

  @ApiProperty({ minimum: 0, type: Number })
  voted_count!: number;

  @ApiProperty({ type: () => [PollParticipantResponseDto] })
  voted_students!: PollParticipantResponseDto[];
}
