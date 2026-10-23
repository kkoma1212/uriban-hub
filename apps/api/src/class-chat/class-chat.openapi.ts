import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

class ClassChatAuthorResponseDto {
  @ApiPropertyOptional({
    description: "대화 상태의 메시지 작성자에만. 지금 사진을 받을 수 있으면 true",
    type: Boolean,
  })
  has_profile_photo?: boolean;
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String }) member_id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ["student", "teacher"] }) role!: "student" | "teacher";
  @ApiProperty({ nullable: true, type: Number }) student_number!: number | null;
}

export class ClassChatMessageResponseDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String }) id!: string;
  @ApiProperty({ type: ClassChatAuthorResponseDto }) author!: ClassChatAuthorResponseDto;
  @ApiProperty({ description: "담임이 가린 메시지는 학생에게 null", nullable: true, type: String })
  body!: string | null;
  @ApiProperty() hidden!: boolean;
  @ApiProperty({ format: "date-time" }) created_at!: string;
  @ApiProperty() mine!: boolean;
}

class ClassChatRoomResponseDto {
  @ApiProperty() is_open!: boolean;
}

class ClassChatMeResponseDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String }) member_id!: string;
  @ApiProperty({ enum: ["student", "teacher"] }) role!: "student" | "teacher";
  @ApiProperty() can_send!: boolean;
  @ApiProperty({ enum: ["closed", "night", "muted"], nullable: true, type: String })
  blocked_reason!: "closed" | "night" | "muted" | null;
  @ApiProperty({ format: "date-time", nullable: true, type: String }) muted_until!: string | null;
}

export class ClassChatStateResponseDto {
  @ApiProperty({ type: ClassChatRoomResponseDto }) room!: ClassChatRoomResponseDto;
  @ApiProperty({ type: ClassChatMeResponseDto }) me!: ClassChatMeResponseDto;
  @ApiProperty({ type: [ClassChatMessageResponseDto] }) messages!: ClassChatMessageResponseDto[];
  @ApiProperty() has_more_before!: boolean;
  @ApiProperty({ description: "담임에게만", nullable: true, type: Number })
  open_report_count!: number | null;
}

export class ClassChatReportResponseDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String }) id!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ format: "date-time" }) created_at!: string;
  @ApiProperty({ type: ClassChatAuthorResponseDto }) reporter!: ClassChatAuthorResponseDto;
  @ApiProperty({ type: ClassChatMessageResponseDto }) message!: ClassChatMessageResponseDto;
}

export class ClassChatReportListResponseDto {
  @ApiProperty({ type: [ClassChatReportResponseDto] }) items!: ClassChatReportResponseDto[];
}
