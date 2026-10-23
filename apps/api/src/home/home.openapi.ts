import { ApiProperty, ApiPropertyOptional, getSchemaPath } from "@nestjs/swagger";

import {
  AttendanceCountsResponseDto,
  AttendanceNotificationItemResponseDto,
} from "../attendance-notifications/attendance-notifications.openapi.js";
import { NoticeConfirmationCountsResponseDto } from "../notices/notices.openapi.js";
import { SupplyCheckCountsResponseDto } from "../supplies/supplies.openapi.js";
import type {
  CheckState,
  ConfirmationState,
  HomeMeal,
  HomeMealMenuItem,
  HomeNotice,
  HomeBirthday,
  HomePoll,
  HomeReminder,
  HomeResult,
  HomeSchedule,
  HomeSupply,
  TeacherHomeNoticeFollowup,
  TeacherHomeSupplyFollowup,
} from "./home.types.js";

const ALLERGEN_CODES = Array.from({ length: 19 }, (_, index) => String(index + 1));
const CHECK_STATES: CheckState[] = ["checked", "modified_unconfirmed", "unchecked"];
const CONFIRMATION_STATES: ConfirmationState[] = ["confirmed", "modified_unconfirmed", "unread"];

export class HomeMealMenuItemResponseDto implements HomeMealMenuItem {
  @ApiProperty({ enum: ALLERGEN_CODES, isArray: true })
  allergens!: string[];

  @ApiProperty({ maxLength: 100, type: String })
  name!: string;
}

export class HomeMealResponseDto implements HomeMeal {
  @ApiProperty({
    example: 1452.2,
    maximum: 9999.9,
    minimum: 0,
    nullable: true,
    type: Number,
  })
  calorie_kcal!: number | null;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  meal_date!: string;

  @ApiProperty({ type: () => [HomeMealMenuItemResponseDto] })
  menu!: HomeMealMenuItemResponseDto[];

  @ApiProperty({ enum: ["neis", "seed"] })
  source!: "neis" | "seed";

  @ApiProperty({
    example: "2026-07-29",
    format: "date",
    nullable: true,
    type: String,
  })
  source_loaded_on!: string | null;

  @ApiProperty({ example: "2026-07-14T03:00:00.000Z", format: "date-time", type: String })
  source_updated_at!: string;
}

export class HomeReminderResponseDto implements HomeReminder {
  /* 준비물일 때만 온다 — 공지에는 분류가 없다. */
  @ApiPropertyOptional({ enum: ["general", "homework"] })
  category?: "general" | "homework";

  @ApiProperty({ enum: ["notice", "supply"] })
  reminder_type!: "notice" | "supply";

  @ApiProperty({ example: "2026-07-24T07:00:00.000Z", format: "date-time", type: String })
  requested_at!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  resource_id!: string;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class HomeNoticeResponseDto implements HomeNotice {
  @ApiPropertyOptional({ enum: CONFIRMATION_STATES })
  confirmation_state?: ConfirmationState;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ type: Boolean })
  is_important!: boolean;

  @ApiProperty({ example: "2026-07-14T03:00:00.000Z", format: "date-time", type: String })
  published_at!: string;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class HomePollResponseDto implements HomePoll {
  /** 선거는 마감 시각이 없다 — 교사가 닫을 때까지 열려 있다. */
  @ApiProperty({ format: "date-time", nullable: true, type: String })
  closes_at!: string | null;

  @ApiProperty({ type: Boolean })
  has_voted!: boolean;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ enum: ["election", "poll"] })
  kind!: HomePoll["kind"];

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class HomeSupplyResponseDto implements HomeSupply {
  @ApiProperty({ enum: ["general", "homework"] })
  category!: HomeSupply["category"];

  @ApiPropertyOptional({ enum: CHECK_STATES })
  check_state?: CheckState;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ maxLength: 500, nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "2026-07-15", format: "date", type: String })
  needed_on!: string;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class HomeScheduleResponseDto implements HomeSchedule {
  @ApiProperty({ example: "D-3", type: String })
  d_day_label!: string;

  @ApiProperty({ minimum: 0, type: Number })
  days_until!: number;

  @ApiProperty({ example: "2026-07-17", format: "date", type: String })
  due_date!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ enum: ["assignment", "exam", "other", "performance"] })
  schedule_type!: HomeSchedule["schedule_type"];

  @ApiProperty({ maxLength: 100, nullable: true, type: String })
  subject!: string | null;

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class TeacherHomeNoticeFollowupResponseDto implements TeacherHomeNoticeFollowup {
  @ApiProperty({ example: "2", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ type: NoticeConfirmationCountsResponseDto })
  counts!: NoticeConfirmationCountsResponseDto;

  @ApiProperty({ type: Boolean })
  is_important!: boolean;

  @ApiProperty({
    example: "2026-07-24T07:00:00.000Z",
    format: "date-time",
    nullable: true,
    type: String,
  })
  last_reminder_requested_at!: string | null;

  @ApiProperty({ example: "2026-07-24T03:00:00.000Z", format: "date-time", type: String })
  published_at!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  resource_id!: string;

  @ApiProperty({ enum: ["notice"] })
  resource_type!: "notice";

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class TeacherHomeSupplyFollowupResponseDto implements TeacherHomeSupplyFollowup {
  @ApiProperty({ enum: ["general", "homework"] })
  category!: "general" | "homework";

  @ApiProperty({ example: "2", pattern: "^[1-9][0-9]*$", type: String })
  content_revision!: string;

  @ApiProperty({ type: SupplyCheckCountsResponseDto })
  counts!: SupplyCheckCountsResponseDto;

  @ApiProperty({
    example: "2026-07-24T07:00:00.000Z",
    format: "date-time",
    nullable: true,
    type: String,
  })
  last_reminder_requested_at!: string | null;

  @ApiProperty({ example: "2026-07-25", format: "date", type: String })
  needed_on!: string;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  resource_id!: string;

  @ApiProperty({ enum: ["supply"] })
  resource_type!: "supply";

  @ApiProperty({ maxLength: 100, type: String })
  title!: string;
}

export class HomeBirthdayResponseDto implements HomeBirthday {
  @ApiProperty({ type: String })
  display_name!: string;

  @ApiProperty({ pattern: "^[1-9][0-9]*$", type: String })
  member_id!: string;
}

export class HomeResponseDto implements HomeResult {
  @ApiPropertyOptional({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            nullable: true,
            oneOf: [
              { $ref: getSchemaPath(AttendanceNotificationItemResponseDto) },
              { $ref: getSchemaPath(AttendanceCountsResponseDto) },
            ],
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            nullable: true,
            oneOf: [
              { $ref: getSchemaPath(AttendanceNotificationItemResponseDto) },
              { $ref: getSchemaPath(AttendanceCountsResponseDto) },
            ],
          },
          error_code: { enum: ["ATTENDANCE_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  attendance?: NonNullable<HomeResult["attendance"]>;

  @ApiPropertyOptional({
    description: "생년월일 칸이 설치된 환경에서만. 오늘 생일이고 알리기를 켠 학생",
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: { items: { $ref: getSchemaPath(HomeBirthdayResponseDto) }, type: "array" },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: { items: { $ref: getSchemaPath(HomeBirthdayResponseDto) }, type: "array" },
          error_code: { enum: ["BIRTHDAY_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  birthdays?: NonNullable<HomeResult["birthdays"]>;

  @ApiProperty({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            allOf: [{ $ref: getSchemaPath(HomeMealResponseDto) }],
            nullable: true,
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            allOf: [{ $ref: getSchemaPath(HomeMealResponseDto) }],
            nullable: true,
          },
          error_code: { enum: ["MEAL_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  meal!: HomeResult["meal"];

  @ApiProperty({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeNoticeResponseDto) },
            type: "array",
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeNoticeResponseDto) },
            type: "array",
          },
          error_code: { enum: ["NOTICE_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  notices!: HomeResult["notices"];

  @ApiProperty({ minimum: 0, nullable: true, type: Number })
  pending_member_count!: number | null;

  @ApiPropertyOptional({
    description: "교사만: 승인된 학생 수(반 관리와 같은 기준). 학생 홈에는 없다.",
    minimum: 0,
    type: Number,
  })
  active_student_count?: number;

  @ApiPropertyOptional({
    description:
      "학생만: 소식 탭 '안 한 것'과 같은 기준의 남은 공지·준비물 수(투표 제외). 셀 수 없으면 null.",
    minimum: 0,
    nullable: true,
    type: Number,
  })
  unresolved_count?: number | null;

  @ApiPropertyOptional({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomePollResponseDto) },
            maxItems: 2,
            type: "array",
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomePollResponseDto) },
            maxItems: 2,
            type: "array",
          },
          error_code: { enum: ["POLL_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  polls?: NonNullable<HomeResult["polls"]>;

  @ApiProperty({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeReminderResponseDto) },
            type: "array",
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeReminderResponseDto) },
            type: "array",
          },
          error_code: { enum: ["REMINDER_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  reminders!: HomeResult["reminders"];

  @ApiProperty({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeScheduleResponseDto) },
            type: "array",
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeScheduleResponseDto) },
            type: "array",
          },
          error_code: { enum: ["SCHEDULE_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  schedules!: HomeResult["schedules"];

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;

  @ApiProperty({
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeSupplyResponseDto) },
            type: "array",
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            items: { $ref: getSchemaPath(HomeSupplyResponseDto) },
            type: "array",
          },
          error_code: { enum: ["SUPPLY_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  supplies!: HomeResult["supplies"];

  @ApiProperty({
    oneOf: [
      {
        additionalProperties: false,
        nullable: true,
        properties: {
          data: {
            items: {
              discriminator: {
                mapping: {
                  notice: getSchemaPath(TeacherHomeNoticeFollowupResponseDto),
                  supply: getSchemaPath(TeacherHomeSupplyFollowupResponseDto),
                },
                propertyName: "resource_type",
              },
              oneOf: [
                { $ref: getSchemaPath(TeacherHomeNoticeFollowupResponseDto) },
                { $ref: getSchemaPath(TeacherHomeSupplyFollowupResponseDto) },
              ],
            },
            maxItems: 3,
            type: "array",
          },
          status: { enum: ["empty", "ok"], type: "string" },
        },
        required: ["data", "status"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          data: {
            items: {
              discriminator: {
                mapping: {
                  notice: getSchemaPath(TeacherHomeNoticeFollowupResponseDto),
                  supply: getSchemaPath(TeacherHomeSupplyFollowupResponseDto),
                },
                propertyName: "resource_type",
              },
              oneOf: [
                { $ref: getSchemaPath(TeacherHomeNoticeFollowupResponseDto) },
                { $ref: getSchemaPath(TeacherHomeSupplyFollowupResponseDto) },
              ],
            },
            maxItems: 3,
            type: "array",
          },
          error_code: { enum: ["FOLLOWUP_QUERY_FAILED"], type: "string" },
          message: { type: "string" },
          status: { enum: ["error"], type: "string" },
        },
        required: ["data", "error_code", "message", "status"],
        type: "object",
      },
    ],
  })
  teacher_followups!: HomeResult["teacher_followups"];
}
