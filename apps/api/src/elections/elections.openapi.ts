import { ApiProperty } from "@nestjs/swagger";

const STATUSES = ["draft", "open", "closed", "published"];
const TIE_BREAKS = ["revote", "elder", "teacher_decides"];
const RESULTS_VISIBILITIES = ["winner_only", "with_counts"];

export class ElectionCandidateResponseDto {
  @ApiProperty({ description: "등록 당시의 표시명", type: String })
  display_name!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ nullable: true, type: Number })
  student_number!: number | null;
}

export class ElectionSummaryResponseDto {
  @ApiProperty({ nullable: true, type: String })
  closed_at!: string | null;

  @ApiProperty({ type: String })
  created_at!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  opened_at!: string | null;

  @ApiProperty({ nullable: true, type: String })
  published_at!: string | null;

  @ApiProperty({ enum: RESULTS_VISIBILITIES, type: String })
  results_visibility!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ enum: STATUSES, type: String })
  status!: string;

  @ApiProperty({
    description: "개표 전에 정해지고 그 뒤 바뀌지 않는다",
    enum: TIE_BREAKS,
    type: String,
  })
  tie_break!: string;

  @ApiProperty({ type: String })
  title!: string;
}

export class ElectionItemResponseDto extends ElectionSummaryResponseDto {
  @ApiProperty({ isArray: true, type: () => ElectionCandidateResponseDto })
  candidates!: ElectionCandidateResponseDto[];

  @ApiProperty({
    description: "투표를 마친 사람 수. 누가 했는지는 내려보내지 않는다.",
    type: Number,
  })
  participant_count!: number;
}

export class ElectionListResponseDto {
  @ApiProperty({ isArray: true, type: () => ElectionSummaryResponseDto })
  items!: ElectionSummaryResponseDto[];
}

export class ElectionPublicResponseDto {
  @ApiProperty({ isArray: true, type: () => ElectionCandidateResponseDto })
  candidates!: ElectionCandidateResponseDto[];

  @ApiProperty({
    description: "내가 투표를 마쳤는지. 무엇을 골랐는지는 서버도 모른다.",
    type: Boolean,
  })
  has_voted!: boolean;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ type: Number })
  participant_count!: number;

  @ApiProperty({ enum: STATUSES, type: String })
  status!: string;

  @ApiProperty({ type: String })
  title!: string;
}

export class ElectionCurrentResponseDto {
  @ApiProperty({ nullable: true, type: () => ElectionPublicResponseDto })
  item!: ElectionPublicResponseDto | null;
}

export class ElectionTallyResponseDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  candidate_id!: string;

  @ApiProperty({ type: String })
  display_name!: string;

  @ApiProperty({ nullable: true, type: Number })
  student_number!: number | null;

  @ApiProperty({ type: Number })
  vote_count!: number;
}

export class ElectionResultsResponseDto {
  @ApiProperty({
    description: "최다 득표 후보들. 하나면 그대로 당선, 여럿이면 동표다.",
    isArray: true,
    type: String,
  })
  leading_candidate_ids!: string[];

  @ApiProperty({ type: Number })
  participant_count!: number;

  @ApiProperty({ enum: RESULTS_VISIBILITIES, type: String })
  results_visibility!: string;

  @ApiProperty({ enum: STATUSES, type: String })
  status!: string;

  @ApiProperty({
    description: "당선자만 공개하는 선거에서는 학생에게 null로 내려간다. 교사에게는 항상 보인다.",
    isArray: true,
    nullable: true,
    type: () => ElectionTallyResponseDto,
  })
  tallies!: ElectionTallyResponseDto[] | null;

  @ApiProperty({ enum: TIE_BREAKS, type: String })
  tie_break!: string;

  @ApiProperty({ description: "동표 처리 절차를 거쳐 정해졌는지", type: Boolean })
  tie_break_applied!: boolean;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ nullable: true, type: () => ElectionCandidateResponseDto })
  winner!: ElectionCandidateResponseDto | null;
}
