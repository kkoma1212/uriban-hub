import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
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

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { MemberPhotoPresenceReader } from "../profile-photos/member-photo-presence.js";
import type { ProfilePhotoActor } from "../profile-photos/profile-photo.types.js";
import {
  CreateHelpRequestDto,
  ListHelpRequestsQueryDto,
  ResolveHelpRequestDto,
  SendHelpMessageDto,
} from "./help-requests.dto.js";
import {
  HelpRequestItemResponseDto,
  HelpRequestListResponseDto,
  HelpRequestThreadResponseDto,
} from "./help-requests.openapi.js";
import { HelpRequestsService } from "./help-requests.service.js";
import type {
  HelpRequestItem,
  HelpRequestListResult,
  HelpRequestThread,
} from "./help-requests.types.js";

const CSRF_HEADER = { name: "X-CSRF-Token", required: true, schema: { type: "string" } } as const;
const ID_PARAM = { name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } } as const;

@ApiTags("help-requests")
@Controller("help-requests")
export class HelpRequestsController {
  constructor(
    private readonly helpRequests: HelpRequestsService,
    private readonly photos: MemberPhotoPresenceReader,
  ) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "도움 요청 목록(담임은 반 전체, 학생은 자기 요청만)" })
  @ApiOkResponse({ type: HelpRequestListResponseDto })
  list(
    @Query() query: ListHelpRequestsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestListResult> {
    const session = getAuthenticatedSession(request);
    return this.helpRequests.list({
      actorUserId: session.userId,
      status: query.status ?? "open",
      ...(query.target_kind === undefined || query.target_id === undefined
        ? {}
        : { target: { id: query.target_id, kind: query.target_kind } }),
    });
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생이 공지·준비물에 '질문 있어요/준비하기 어려워요' 요청" })
  @ApiBody({ type: CreateHelpRequestDto })
  @ApiHeader(CSRF_HEADER)
  @ApiCreatedResponse({ type: HelpRequestItemResponseDto })
  create(
    @Body() body: CreateHelpRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestItem> {
    const session = getAuthenticatedSession(request);
    return this.helpRequests.create({
      actorUserId: session.userId,
      kind: body.kind,
      message: body.message,
      target: { id: body.target_id, kind: body.target_kind },
    });
  }

  @Post("general")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생이 글과 무관하게 선생님께 묻기(열린 대화가 있으면 이어 쓴다)" })
  @ApiBody({ type: SendHelpMessageDto })
  @ApiHeader(CSRF_HEADER)
  @ApiCreatedResponse({ type: HelpRequestThreadResponseDto })
  startGeneral(
    @Body() body: SendHelpMessageDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestThread> {
    const session = getAuthenticatedSession(request);
    return this.withParticipantPhoto(
      session,
      this.helpRequests.startGeneral({ actorUserId: session.userId, body: body.body }),
    );
  }

  @Get(":id/messages")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "대화 한 건과 주고받은 메시지(학생은 자기 대화, 담임은 반 전체)" })
  @ApiParam(ID_PARAM)
  @ApiOkResponse({ type: HelpRequestThreadResponseDto })
  thread(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestThread> {
    const session = getAuthenticatedSession(request);
    return this.withParticipantPhoto(session, this.helpRequests.thread(session.userId, id));
  }

  @Post(":id/messages")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "대화에 메시지 보내기(닫힌 대화는 다시 열린다)" })
  @ApiParam(ID_PARAM)
  @ApiBody({ type: SendHelpMessageDto })
  @ApiHeader(CSRF_HEADER)
  @ApiCreatedResponse({ type: HelpRequestThreadResponseDto })
  send(
    @Param("id") id: string,
    @Body() body: SendHelpMessageDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestThread> {
    const session = getAuthenticatedSession(request);
    return this.withParticipantPhoto(
      session,
      this.helpRequests.send({
        actorUserId: session.userId,
        body: body.body,
        helpRequestId: id,
      }),
    );
  }

  @Post(":id/withdraw")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생이 처리 중인 자기 요청을 철회" })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF_HEADER)
  @ApiOkResponse({ type: HelpRequestItemResponseDto })
  withdraw(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestItem> {
    const session = getAuthenticatedSession(request);
    return this.helpRequests.withdraw({
      actorUserId: session.userId,
      helpRequestId: id,
    });
  }

  @Post(":id/resolve")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임이 처리 완료(선택 한 줄 답변)" })
  @ApiParam(ID_PARAM)
  @ApiBody({ type: ResolveHelpRequestDto })
  @ApiHeader(CSRF_HEADER)
  @ApiOkResponse({ type: HelpRequestItemResponseDto })
  resolve(
    @Param("id") id: string,
    @Body() body: ResolveHelpRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<HelpRequestItem> {
    const session = getAuthenticatedSession(request);
    return this.helpRequests.resolve({
      actorUserId: session.userId,
      helpRequestId: id,
      reply: body.reply,
    });
  }

  /**
   * 대화를 돌려주는 경로에서 상대의 '사진 있음'을 붙인다 — 화면이 이 응답으로 대화를 바꾼다.
   * 담임이 받는 대화는 학생(student)에, 학생이 받는 대화(student가 null)는 담임 사진 여부를 붙인다.
   */
  private async withParticipantPhoto(
    actor: ProfilePhotoActor,
    pending: Promise<HelpRequestThread>,
  ): Promise<HelpRequestThread> {
    const thread = await pending;
    const student = thread.request.student;
    if (student === null)
      return {
        ...thread,
        teacher_has_profile_photo: await this.photos.classTeacherHasPhoto(actor),
      };
    const withPhoto = await this.photos.memberIdsWithPhoto(actor, [student.member_id]);
    return {
      ...thread,
      request: {
        ...thread.request,
        student: { ...student, has_profile_photo: withPhoto.has(student.member_id) },
      },
    };
  }
}
