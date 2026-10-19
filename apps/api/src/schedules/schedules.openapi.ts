import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from "@nestjs/swagger";

import type { ScheduleType } from "./schedules.types.js";

const SCHEDULE_TYPES: ScheduleType[] = ["exam", "performance", "assignment", "other"];

export class ScheduleItemResponseDto {
  @ApiProperty({ example: "D-1", nullable: true, type: String })
  d_day_label!: string | null;

  @ApiProperty({ example: 1, type: Number })
  days_until!: number;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ example: "2026-07-15", format: "date", type: String })
  due_date!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  row_version!: string;

  @ApiProperty({ enum: SCHEDULE_TYPES })
  schedule_type!: ScheduleType;

  @ApiProperty({ maxLength: 30, nullable: true, type: String })
  subject!: string | null;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class ScheduleDateRangeResponseDto {
  @ApiProperty({ format: "date", type: String })
  start_date!: string;

  @ApiProperty({ format: "date", type: String })
  end_date!: string;
}

export class ScheduleListResponseDto {
  @ApiPropertyOptional({
    description: "today/this_week에서 서버가 적용한 양끝 포함 KST 조회 기간",
    type: () => ScheduleDateRangeResponseDto,
  })
  date_range?: ScheduleDateRangeResponseDto;

  @ApiProperty({ type: () => [ScheduleItemResponseDto] })
  items!: ScheduleItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;
}

export class ClassScheduleCalendarItemResponseDto extends ScheduleItemResponseDto {
  @ApiProperty({ enum: ["class"] })
  source!: "class";
}

export class SchoolScheduleCalendarItemResponseDto {
  @ApiProperty({ example: "D-1", nullable: true, type: String })
  d_day_label!: string | null;

  @ApiProperty({ example: 1, type: Number })
  days_until!: number;

  @ApiProperty({ maxLength: 2000, nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ example: "2026-07-15", format: "date", type: String })
  due_date!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "휴업일", maxLength: 30, type: String })
  school_day_type!: string;

  @ApiProperty({ enum: ["school"] })
  source!: "school";

  @ApiProperty({ example: "2026-07-30", format: "date", type: String })
  source_loaded_on!: string;

  @ApiProperty({ example: [1, 2, 3], isArray: true, maximum: 6, minimum: 1, type: Number })
  target_grades!: number[];

  @ApiProperty({ example: "2차 정기시험", maxLength: 200, type: String })
  title!: string;
}

export class ScheduleCalendarHolidayResponseDto {
  @ApiProperty({ example: "2026-08-15", format: "date", type: String })
  date!: string;

  @ApiProperty({ example: "광복절", maxLength: 60, type: String })
  name!: string;
}

@ApiExtraModels(ClassScheduleCalendarItemResponseDto, SchoolScheduleCalendarItemResponseDto)
export class ScheduleCalendarResponseDto {
  @ApiProperty({ example: "2026-08-08", format: "date", type: String })
  end_date!: string;

  @ApiProperty({
    description:
      "요청 범위의 법정공휴일. 전국 공통 공개 정보라 90일 열람 제한을 적용하지 않는다. " +
      "공급 계약이 채워지지 않은 해는 빈 배열이다.",
    isArray: true,
    type: ScheduleCalendarHolidayResponseDto,
  })
  holidays!: ScheduleCalendarHolidayResponseDto[];

  @ApiProperty({
    items: {
      oneOf: [
        { $ref: getSchemaPath(ClassScheduleCalendarItemResponseDto) },
        { $ref: getSchemaPath(SchoolScheduleCalendarItemResponseDto) },
      ],
    },
    type: "array",
  })
  items!: Array<ClassScheduleCalendarItemResponseDto | SchoolScheduleCalendarItemResponseDto>;

  @ApiProperty({
    description: "기존 일정 열람 정책에 따라 조회 가능한 가장 이른 KST 날짜",
    example: "2026-04-15",
    format: "date",
    type: String,
  })
  oldest_visible_date!: string;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;

  @ApiProperty({ example: "2026-06-28", format: "date", type: String })
  start_date!: string;
}

export class ScheduleLinkedNoticeResponseDto {
  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ type: Boolean })
  is_important!: boolean;

  @ApiProperty({ type: String })
  title!: string;
}

export class ScheduleLinkedSupplyResponseDto {
  @ApiProperty({ enum: ["general", "homework"] })
  category!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "2026-09-30", format: "date", type: String })
  needed_on!: string;

  @ApiProperty({ type: String })
  title!: string;
}

export class ScheduleLinksResponseDto {
  @ApiProperty({
    description: "연결된 공지(학생에게는 자기에게 공개된 것만)",
    isArray: true,
    type: ScheduleLinkedNoticeResponseDto,
  })
  notices!: ScheduleLinkedNoticeResponseDto[];

  @ApiProperty({
    description: "연결된 준비물(학생에게는 자기에게 공개된 것만)",
    isArray: true,
    type: ScheduleLinkedSupplyResponseDto,
  })
  supplies!: ScheduleLinkedSupplyResponseDto[];
}
