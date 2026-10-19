import { ApiProperty } from "@nestjs/swagger";

class HelpRequestTargetResponseDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ enum: ["notice", "supply"] })
  kind!: string;

  @ApiProperty({ type: String })
  title!: string;
}

class HelpRequestStudentResponseDto {
  @ApiProperty({ type: String })
  display_name!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  member_id!: string;

  @ApiProperty({ nullable: true, type: Number })
  student_number!: number | null;
}

export class HelpRequestItemResponseDto {
  @ApiProperty({ format: "date-time", nullable: true, type: String })
  closed_at!: string | null;

  @ApiProperty({ format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ enum: ["question", "hard_to_prepare", "general"] })
  kind!: string;

  @ApiProperty({
    description: "요청이나 마지막 메시지 중 늦은 시각(목록 정렬 기준)",
    format: "date-time",
    type: String,
  })
  last_activity_at!: string;

  @ApiProperty({ nullable: true, type: String })
  message!: string | null;

  @ApiProperty({ description: "담임의 선택 한 줄 답변", nullable: true, type: String })
  reply!: string | null;

  @ApiProperty({ enum: ["open", "resolved", "withdrawn"] })
  status!: string;

  @ApiProperty({
    description: "교사에게만 채운다(학생은 자기 요청만 받으므로 null)",
    nullable: true,
    type: HelpRequestStudentResponseDto,
  })
  student!: HelpRequestStudentResponseDto | null;

  @ApiProperty({
    description: "글과 무관한 대화(general)는 null",
    nullable: true,
    type: HelpRequestTargetResponseDto,
  })
  target!: HelpRequestTargetResponseDto | null;
}

export class HelpRequestListResponseDto {
  @ApiProperty({ isArray: true, type: HelpRequestItemResponseDto })
  items!: HelpRequestItemResponseDto[];
}

class HelpRequestMessageResponseDto {
  @ApiProperty({ enum: ["student", "teacher"] })
  author!: string;

  @ApiProperty({ type: String })
  body!: string;

  @ApiProperty({ format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;
}

export class HelpRequestThreadResponseDto {
  @ApiProperty({
    description: "오래된 것부터 최근 200개. 첫 설명·예전 답변은 request.message·reply",
    isArray: true,
    type: HelpRequestMessageResponseDto,
  })
  messages!: HelpRequestMessageResponseDto[];

  @ApiProperty({ type: HelpRequestItemResponseDto })
  request!: HelpRequestItemResponseDto;
}
