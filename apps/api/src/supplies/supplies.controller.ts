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
import { normalizeContentAudience } from "../content-audiences/content-audiences.service.js";
import { CreateInAppReminderDto } from "../in-app-reminders/in-app-reminders.dto.js";
import {
  ApiInAppReminderFailureResponses,
  InAppReminderResponseDto,
} from "../in-app-reminders/in-app-reminders.openapi.js";
import type { InAppReminderResult } from "../in-app-reminders/in-app-reminders.types.js";
import {
  CreateSupplyDto,
  DeleteSupplyDto,
  ListSuppliesQueryDto,
  ListSupplyChecksQueryDto,
  SetSupplyCheckDto,
  UpdateSupplyDto,
} from "./supplies.dto.js";
import {
  SupplyCheckResponseDto,
  SupplyChecksResponseDto,
  SupplyItemResponseDto,
  SupplyListResponseDto,
} from "./supplies.openapi.js";
import { SuppliesService } from "./supplies.service.js";
import type {
  ListSuppliesResult,
  ListSupplyChecksResult,
  SupplyCheckResult,
  SupplyItem,
} from "./supplies.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

@ApiTags("supplies")
@Controller("supplies")
export class SuppliesController {
  constructor(private readonly suppliesService: SuppliesService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반의 다가오는·오늘·이번 주·지난 준비물·숙제 목록" })
  @ApiQuery({
    enum: ["upcoming", "today", "this_week", "past"],
    name: "scope",
    required: true,
    description: "한국 시간 기준. today는 오늘 하루, this_week는 월요일~일요일(지난 날짜 포함).",
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ description: "20개 커서 페이지 준비물 목록", type: SupplyListResponseDto })
  list(
    @Query() query: ListSuppliesQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListSuppliesResult> {
    const session = getAuthenticatedSession(request);
    return this.suppliesService.list({
      actorUserId: session.userId,
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.check_state === undefined ? {} : { checkState: query.check_state }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      scope: query.scope,
      ...(query.q === undefined ? {} : { search: query.q }),
    });
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 준비물 등록" })
  @ApiBody({ type: CreateSupplyDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    description: "등록된 준비물",
    headers: ETAG_RESPONSE_HEADERS,
    type: SupplyItemResponseDto,
  })
  async create(
    @Body() body: CreateSupplyDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SupplyItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.suppliesService.create({
      actorUserId: session.userId,
      audience: normalizeContentAudience(body.audience),
      category: body.category ?? "general",
      description: body.description ?? null,
      idempotencyKey,
      neededOn: body.needed_on,
      requestId: request.id,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":id/reminders")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 준비물 미확인 학생 인앱 재알림 요청" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: CreateInAppReminderDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    description: "현재 미확인 학생 중 재알림 대기 시간이 지난 학생에게 생성된 인앱 재알림",
    type: InAppReminderResponseDto,
  })
  @ApiInAppReminderFailureResponses()
  createReminder(
    @Param("id") id: string,
    @Body() body: CreateInAppReminderDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<InAppReminderResult> {
    const session = getAuthenticatedSession(request);
    return this.suppliesService.createReminder({
      actorUserId: session.userId,
      contentRevision: String(body.content_revision),
      idempotencyKey,
      requestId: request.id,
      supplyId: id,
    });
  }

  @Get(":id/checks")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사용 준비물 챙김 상태별 학생 현황" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiQuery({
    enum: ["checked", "unchecked", "modified_unconfirmed"],
    name: "state",
    required: true,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({
    description: "선택 상태 학생 목록과 전체 상태별 수",
    type: SupplyChecksResponseDto,
  })
  listChecks(
    @Param("id") id: string,
    @Query() query: ListSupplyChecksQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListSupplyChecksResult> {
    const session = getAuthenticatedSession(request);
    return this.suppliesService.listChecks({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      state: query.state,
      supplyId: id,
    });
  }

  @Put(":id/check")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 준비물 챙김 desired-state 설정" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: SetSupplyCheckDto })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ description: "현재 준비물 챙김 상태", type: SupplyCheckResponseDto })
  setCheck(
    @Param("id") id: string,
    @Body() body: SetSupplyCheckDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<SupplyCheckResult> {
    const session = getAuthenticatedSession(request);
    return this.suppliesService.setCheck({
      actorUserId: session.userId,
      contentRevision: String(body.content_revision),
      isChecked: body.is_checked,
      supplyId: id,
    });
  }

  @Get(":id")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 준비물 상세 조회" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({
    description: "준비물 상세",
    headers: ETAG_RESPONSE_HEADERS,
    type: SupplyItemResponseDto,
  })
  async get(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SupplyItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.suppliesService.get({ actorUserId: session.userId, supplyId: id });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Patch(":id")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 준비물 수정" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: UpdateSupplyDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({
    description: "수정되었거나 no-op인 준비물",
    headers: ETAG_RESPONSE_HEADERS,
    type: SupplyItemResponseDto,
  })
  async update(
    @Param("id") id: string,
    @Body() body: UpdateSupplyDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SupplyItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.suppliesService.update({
      actorUserId: session.userId,
      category: body.category,
      description: body.description,
      ifMatch,
      minorEdit: body.minor_edit,
      neededOn: body.needed_on,
      requestId: request.id,
      supplyId: id,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 준비물 soft delete" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: DeleteSupplyDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiNoContentResponse({ description: "준비물 삭제 완료" })
  async delete(
    @Param("id") id: string,
    @Body() body: DeleteSupplyDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    await this.suppliesService.delete({
      actorUserId: session.userId,
      ifMatch,
      reason: body.reason,
      requestId: request.id,
      supplyId: id,
    });
  }
}
