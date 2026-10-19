import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import {
  CreateScheduleDto,
  DeleteScheduleDto,
  ListSchedulesQueryDto,
  ScheduleCalendarQueryDto,
  UpdateScheduleDto,
  UpdateScheduleLinksDto,
} from "./schedules.dto.js";
import {
  ScheduleCalendarResponseDto,
  ScheduleItemResponseDto,
  ScheduleLinksResponseDto,
  ScheduleListResponseDto,
} from "./schedules.openapi.js";
import { SchedulesService } from "./schedules.service.js";
import type {
  ListSchedulesResult,
  ScheduleCalendarResult,
  ScheduleItem,
  ScheduleLinksResult,
} from "./schedules.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

@ApiTags("schedules")
@Controller("schedules")
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반의 다가오는·오늘·이번 주·지난 일정 목록" })
  @ApiQuery({
    enum: ["upcoming", "today", "this_week", "past"],
    name: "scope",
    required: true,
    description: "한국 시간 기준. today는 오늘 하루, this_week는 월요일~일요일(지난 날짜 포함).",
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "schedule_type",
    required: false,
    enum: ["assignment", "performance", "exam", "other"],
  })
  @ApiQuery({
    name: "q",
    required: false,
    type: String,
    description: "과목·제목·설명 검색어 (최대 50자)",
  })
  @ApiOkResponse({ description: "20개 커서 페이지 일정 목록", type: ScheduleListResponseDto })
  list(
    @Query() query: ListSchedulesQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListSchedulesResult> {
    const session = getAuthenticatedSession(request);
    return this.schedulesService.list({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.schedule_type === undefined ? {} : { scheduleType: query.schedule_type }),
      ...(query.q === undefined ? {} : { search: query.q }),
      scope: query.scope,
    });
  }

  @Get("calendar")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반의 최대 42일 월간 달력 일정" })
  @ApiQuery({
    description: "양끝 포함 조회 시작 KST 날짜",
    name: "start_date",
    required: true,
    schema: { example: "2026-06-28", format: "date", type: "string" },
  })
  @ApiQuery({
    description: "양끝 포함 조회 종료 KST 날짜",
    name: "end_date",
    required: true,
    schema: { example: "2026-08-08", format: "date", type: "string" },
  })
  @ApiOkResponse({
    description: "날짜·ID 오름차순의 달력 일정",
    type: ScheduleCalendarResponseDto,
  })
  calendar(
    @Query() query: ScheduleCalendarQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ScheduleCalendarResult> {
    const session = getAuthenticatedSession(request);
    return this.schedulesService.calendar({
      actorUserId: session.userId,
      endDate: query.end_date,
      startDate: query.start_date,
    });
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 일정 등록" })
  @ApiBody({ type: CreateScheduleDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    description: "등록된 일정",
    headers: ETAG_RESPONSE_HEADERS,
    type: ScheduleItemResponseDto,
  })
  async create(
    @Body() body: CreateScheduleDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScheduleItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.schedulesService.create({
      actorUserId: session.userId,
      description: body.description ?? null,
      dueDate: body.due_date,
      idempotencyKey,
      requestId: request.id,
      scheduleType: body.schedule_type,
      subject: body.subject ?? null,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Get(":id")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 일정 상세 조회" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({
    description: "일정 상세",
    headers: ETAG_RESPONSE_HEADERS,
    type: ScheduleItemResponseDto,
  })
  async get(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScheduleItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.schedulesService.get({
      actorUserId: session.userId,
      scheduleId: id,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Patch(":id")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 일정 수정" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: UpdateScheduleDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({
    description: "수정되었거나 no-op인 일정",
    headers: ETAG_RESPONSE_HEADERS,
    type: ScheduleItemResponseDto,
  })
  async update(
    @Param("id") id: string,
    @Body() body: UpdateScheduleDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScheduleItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.schedulesService.update({
      actorUserId: session.userId,
      description: body.description,
      dueDate: body.due_date,
      ifMatch,
      requestId: request.id,
      scheduleId: id,
      scheduleType: body.schedule_type,
      subject: body.subject,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 일정 soft delete" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: DeleteScheduleDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiNoContentResponse({ description: "일정 삭제 완료" })
  async delete(
    @Param("id") id: string,
    @Body() body: DeleteScheduleDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    await this.schedulesService.delete({
      actorUserId: session.userId,
      ifMatch,
      reason: body.reason,
      requestId: request.id,
      scheduleId: id,
    });
  }

  @Get(":id/links")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "일정에 연결된 공지·준비물(학생에게는 자기에게 공개된 것만)" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({ description: "연결된 공지·준비물", type: ScheduleLinksResponseDto })
  getLinks(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ScheduleLinksResult> {
    const session = getAuthenticatedSession(request);
    return this.schedulesService.getLinks({ actorUserId: session.userId, scheduleId: id });
  }

  @Put(":id/links")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 일정 연결 전체 교체(같은 요청 반복 시 결과 동일)" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: UpdateScheduleLinksDto })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ description: "저장된 연결", type: ScheduleLinksResponseDto })
  replaceLinks(
    @Param("id") id: string,
    @Body() body: UpdateScheduleLinksDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ScheduleLinksResult> {
    const session = getAuthenticatedSession(request);
    return this.schedulesService.replaceLinks({
      actorUserId: session.userId,
      noticeIds: body.notice_ids,
      requestId: request.id,
      scheduleId: id,
      supplyIds: body.supply_ids,
    });
  }
}
