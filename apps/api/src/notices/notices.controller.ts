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
import { MemberPhotoPresenceReader } from "../profile-photos/member-photo-presence.js";
import {
  ConfirmNoticeDto,
  CreateNoticeDto,
  DeleteNoticeDto,
  ListNoticeConfirmationsQueryDto,
  ListNoticesQueryDto,
  UpdateNoticeDto,
} from "./notices.dto.js";
import {
  NoticeConfirmationResponseDto,
  NoticeConfirmationsResponseDto,
  NoticeItemResponseDto,
  NoticeListResponseDto,
} from "./notices.openapi.js";
import { NoticesService } from "./notices.service.js";
import type {
  ListNoticeConfirmationsResult,
  ListNoticesResult,
  NoticeConfirmationResult,
  NoticeItem,
} from "./notices.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

@ApiTags("notices")
@Controller("notices")
export class NoticesController {
  constructor(
    private readonly noticesService: NoticesService,
    private readonly photos: MemberPhotoPresenceReader,
  ) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 공지 목록" })
  @ApiQuery({ enum: ["all", "important", "regular"], name: "importance", required: false })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ description: "20개 커서 페이지 공지 목록", type: NoticeListResponseDto })
  list(
    @Query() query: ListNoticesQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListNoticesResult> {
    const session = getAuthenticatedSession(request);
    return this.noticesService.list({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      importance: query.importance ?? "all",
      ...(query.q === undefined ? {} : { search: query.q }),
    });
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 공지 등록" })
  @ApiBody({ type: CreateNoticeDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    description: "등록된 공지",
    headers: ETAG_RESPONSE_HEADERS,
    type: NoticeItemResponseDto,
  })
  async create(
    @Body() body: CreateNoticeDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NoticeItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.noticesService.create({
      actorUserId: session.userId,
      audience: normalizeContentAudience(body.audience),
      category: body.category ?? "general",
      content: body.content,
      idempotencyKey,
      isImportant: body.is_important ?? false,
      requestId: request.id,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":id/reminders")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 공지 미확인 학생 인앱 재알림 요청" })
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
    return this.noticesService.createReminder({
      actorUserId: session.userId,
      contentRevision: String(body.content_revision),
      idempotencyKey,
      noticeId: id,
      requestId: request.id,
    });
  }

  @Get(":id/confirmations")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사용 공지 확인 상태별 학생 현황" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiQuery({
    enum: ["confirmed", "unread", "modified_unconfirmed"],
    name: "state",
    required: true,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({
    description: "선택 상태 학생 목록과 전체 상태별 수",
    type: NoticeConfirmationsResponseDto,
  })
  async listConfirmations(
    @Param("id") id: string,
    @Query() query: ListNoticeConfirmationsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListNoticeConfirmationsResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.noticesService.listConfirmations({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      noticeId: id,
      state: query.state,
    });
    const withPhoto = await this.photos.memberIdsWithPhoto(
      session,
      result.items.map((item) => item.member_id),
    );
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        has_profile_photo: withPhoto.has(item.member_id),
      })),
    };
  }

  @Put(":id/confirmation")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 현재 공지 리비전 확인" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: ConfirmNoticeDto })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ description: "현재 공지 확인 상태", type: NoticeConfirmationResponseDto })
  confirm(
    @Param("id") id: string,
    @Body() body: ConfirmNoticeDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<NoticeConfirmationResult> {
    const session = getAuthenticatedSession(request);
    return this.noticesService.confirm({
      actorUserId: session.userId,
      contentRevision: String(body.content_revision),
      noticeId: id,
    });
  }

  @Get(":id")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 공지 상세 조회" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({
    description: "공지 상세",
    headers: ETAG_RESPONSE_HEADERS,
    type: NoticeItemResponseDto,
  })
  async get(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NoticeItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.noticesService.get({ actorUserId: session.userId, noticeId: id });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Patch(":id")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 공지 수정" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: UpdateNoticeDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({
    description: "수정되었거나 no-op인 공지",
    headers: ETAG_RESPONSE_HEADERS,
    type: NoticeItemResponseDto,
  })
  async update(
    @Param("id") id: string,
    @Body() body: UpdateNoticeDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NoticeItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.noticesService.update({
      actorUserId: session.userId,
      category: body.category,
      content: body.content,
      ifMatch,
      isImportant: body.is_important,
      minorEdit: body.minor_edit,
      noticeId: id,
      requestId: request.id,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 공지 soft delete" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: DeleteNoticeDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiNoContentResponse({ description: "공지 삭제 완료" })
  async delete(
    @Param("id") id: string,
    @Body() body: DeleteNoticeDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    await this.noticesService.delete({
      actorUserId: session.userId,
      ifMatch,
      noticeId: id,
      reason: body.reason,
      requestId: request.id,
    });
  }
}
