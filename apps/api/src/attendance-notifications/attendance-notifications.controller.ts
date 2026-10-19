import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import {
  GetAttendanceHistoryQueryDto,
  GetAttendanceTodayQueryDto,
} from "./attendance-notifications.dto.js";
import {
  AttendanceStudentHistoryResponseDto,
  AttendanceStudentTodayResponseDto,
  AttendanceTeacherTodayResponseDto,
} from "./attendance-notifications.openapi.js";
import { AttendanceNotificationsService } from "./attendance-notifications.service.js";
import type {
  AttendanceStudentHistoryResult,
  AttendanceTodayResult,
} from "./attendance-notifications.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "학생 알림이 존재할 때 현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

@ApiTags("attendance-notifications")
@ApiExtraModels(
  AttendanceStudentHistoryResponseDto,
  AttendanceStudentTodayResponseDto,
  AttendanceTeacherTodayResponseDto,
)
@Controller("attendance-notifications")
export class AttendanceNotificationsController {
  constructor(private readonly attendanceNotificationsService: AttendanceNotificationsService) {}

  @Get("history")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "학생 본인의 출결 알림 이력" })
  @ApiQuery({
    name: "from",
    required: true,
    schema: { example: "2025-08-01", format: "date", type: "string" },
  })
  @ApiQuery({
    name: "to",
    required: true,
    schema: { example: "2026-07-31", format: "date", type: "string" },
  })
  @ApiOkResponse({
    description: "요청한 기간의 학생 본인 출결 알림과 유형별 합계",
    type: AttendanceStudentHistoryResponseDto,
  })
  history(
    @Query() query: GetAttendanceHistoryQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<AttendanceStudentHistoryResult> {
    const session = getAuthenticatedSession(request);
    return this.attendanceNotificationsService.history({
      actorUserId: session.userId,
      from: query.from,
      to: query.to,
    });
  }

  @Get("today")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 오늘 출결 알림" })
  @ApiQuery({ enum: ["all", "late", "absent", "early"], name: "type", required: false })
  @ApiQuery({
    enum: ["all", "pending", "acknowledged"],
    name: "status",
    required: false,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({
    description: "학생 본인 알림 또는 담임 교사 현황",
    headers: ETAG_RESPONSE_HEADERS,
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AttendanceStudentTodayResponseDto) },
        { $ref: getSchemaPath(AttendanceTeacherTodayResponseDto) },
      ],
    },
  })
  async today(
    @Query() query: GetAttendanceTodayQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AttendanceTodayResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.attendanceNotificationsService.today({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      status: query.status ?? "all",
      type: query.type ?? "all",
    });
    if (result.role === "student" && result.notification !== null) {
      reply.header("ETag", `"${result.notification.row_version}"`);
    }
    return result;
  }
}
