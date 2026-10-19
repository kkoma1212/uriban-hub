import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import {
  AttendanceMutationBodyDto,
  EmptyAttendanceMutationBodyDto,
} from "./attendance-notifications-command.dto.js";
import { AttendanceMutationItemResponseDto } from "./attendance-notifications-command.openapi.js";
import { AttendanceNotificationsCommandService } from "./attendance-notifications-command.service.js";
import type { AttendanceMutationItem } from "./attendance-notifications-command.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

const SERVER_TODAY_HEADER = {
  description: "직전 조회에서 받은 DB 기준 KST 날짜",
  name: "X-Server-Today",
  required: true,
  schema: { example: "2026-07-18", format: "date", type: "string" },
} as const;

@ApiTags("attendance-notifications")
@Controller("attendance-notifications")
export class AttendanceNotificationsCommandController {
  constructor(private readonly commandService: AttendanceNotificationsCommandService) {}

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 오늘 출결 알림 제출 또는 취소 후 재제출" })
  @ApiBody({ type: AttendanceMutationBodyDto })
  @ApiHeader(SERVER_TODAY_HEADER)
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiCreatedResponse({
    description: "오늘 첫 제출",
    headers: ETAG_RESPONSE_HEADERS,
    type: AttendanceMutationItemResponseDto,
  })
  @ApiOkResponse({
    description: "취소 row 재제출 또는 저장 응답 replay",
    headers: ETAG_RESPONSE_HEADERS,
    type: AttendanceMutationItemResponseDto,
  })
  async create(
    @Body() body: AttendanceMutationBodyDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Headers("x-server-today") serverToday: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AttendanceMutationItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.commandService.create({
      actorUserId: session.userId,
      expectedTime: body.expected_time,
      idempotencyKey,
      notificationType: body.notification_type,
      requestId: request.id,
      serverToday,
    });
    reply.status(result.statusCode);
    reply.header("ETag", `"${result.item.row_version}"`);
    return result.item;
  }

  @Patch(":id")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 pending 출결 알림 수정" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: AttendanceMutationBodyDto })
  @ApiHeader(SERVER_TODAY_HEADER)
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiOkResponse({
    description: "수정되었거나 no-op인 출결 알림",
    headers: ETAG_RESPONSE_HEADERS,
    type: AttendanceMutationItemResponseDto,
  })
  async update(
    @Param("id") id: string,
    @Body() body: AttendanceMutationBodyDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Headers("x-server-today") serverToday: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AttendanceMutationItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.commandService.update({
      actorUserId: session.userId,
      attendanceId: id,
      expectedTime: body.expected_time,
      ifMatch,
      notificationType: body.notification_type,
      requestId: request.id,
      serverToday,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 pending 출결 알림 취소" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({
    required: false,
    schema: { additionalProperties: false, maxProperties: 0, type: "object" },
  })
  @ApiHeader(SERVER_TODAY_HEADER)
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiOkResponse({
    description: "취소된 출결 알림",
    headers: ETAG_RESPONSE_HEADERS,
    type: AttendanceMutationItemResponseDto,
  })
  async cancel(
    @Param("id") id: string,
    @Body() _body: EmptyAttendanceMutationBodyDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Headers("x-server-today") serverToday: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AttendanceMutationItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.commandService.cancel({
      actorUserId: session.userId,
      attendanceId: id,
      ifMatch,
      requestId: request.id,
      serverToday,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 pending 출결 알림 확인" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({
    required: false,
    schema: { additionalProperties: false, maxProperties: 0, type: "object" },
  })
  @ApiHeader(SERVER_TODAY_HEADER)
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiOkResponse({
    description: "교사가 확인한 출결 알림",
    headers: ETAG_RESPONSE_HEADERS,
    type: AttendanceMutationItemResponseDto,
  })
  async acknowledge(
    @Param("id") id: string,
    @Body() _body: EmptyAttendanceMutationBodyDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Headers("x-server-today") serverToday: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AttendanceMutationItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.commandService.acknowledge({
      actorUserId: session.userId,
      attendanceId: id,
      ifMatch,
      requestId: request.id,
      serverToday,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }
}
