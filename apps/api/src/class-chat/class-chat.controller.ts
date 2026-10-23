import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiNoContentResponse,
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
  ClassChatStateQueryDto,
  MuteClassChatMemberDto,
  ReportClassChatMessageDto,
  SendClassChatMessageDto,
  UpdateClassChatRoomDto,
} from "./class-chat.dto.js";
import { ClassChatReportListResponseDto, ClassChatStateResponseDto } from "./class-chat.openapi.js";
import { ClassChatService } from "./class-chat.service.js";
import type { ClassChatReport, ClassChatState } from "./class-chat.types.js";

const CSRF_HEADER = { name: "X-CSRF-Token", required: true, schema: { type: "string" } } as const;
const ID_PARAM = { name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } } as const;
const MEMBER_PARAM = {
  name: "memberId",
  schema: { pattern: "^[1-9][0-9]*$", type: "string" },
} as const;

function idOrNotFound(value: string): string {
  // 경로 변수는 DTO 검증을 거치지 않으므로 숫자 번호만 받는다(그 밖은 서비스가 찾지 못함으로 처리).
  return /^[1-9][0-9]{0,18}$/u.test(value) ? value : "0";
}

@ApiTags("class-chat")
@Controller("class-chat")
export class ClassChatController {
  constructor(
    private readonly classChat: ClassChatService,
    private readonly photos: MemberPhotoPresenceReader,
  ) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "반 대화방 상태와 메시지(after가 있으면 그 뒤 메시지만)" })
  @ApiOkResponse({ type: ClassChatStateResponseDto })
  state(
    @Query() query: ClassChatStateQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ClassChatState> {
    const session = getAuthenticatedSession(request);
    return this.withAuthorPhotos(session, this.classChat.state(session.userId, query.after));
  }

  @Post("messages")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "메시지 보내기(학생은 방이 열려 있고 밤이 아니며 제한 중이 아닐 때)" })
  @ApiBody({ type: SendClassChatMessageDto })
  @ApiHeader(CSRF_HEADER)
  @ApiOkResponse({ type: ClassChatStateResponseDto })
  @HttpCode(200)
  send(
    @Body() body: SendClassChatMessageDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ClassChatState> {
    const session = getAuthenticatedSession(request);
    return this.withAuthorPhotos(session, this.classChat.send(session.userId, body.body));
  }

  @Post("messages/:id/hide")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "(담임) 메시지 가리기" })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF_HEADER)
  @ApiOkResponse({ type: ClassChatStateResponseDto })
  @HttpCode(200)
  hide(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ClassChatState> {
    const session = getAuthenticatedSession(request);
    return this.withAuthorPhotos(session, this.classChat.hide(session.userId, idOrNotFound(id)));
  }

  @Post("messages/:id/report")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "메시지 신고(담임에게 보인다)" })
  @ApiParam(ID_PARAM)
  @ApiBody({ type: ReportClassChatMessageDto })
  @ApiHeader(CSRF_HEADER)
  @ApiNoContentResponse()
  @HttpCode(204)
  async report(
    @Param("id") id: string,
    @Body() body: ReportClassChatMessageDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.classChat.report(
      getAuthenticatedSession(request).userId,
      idOrNotFound(id),
      body.reason,
    );
  }

  @Get("reports")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "(담임) 처리하지 않은 신고" })
  @ApiOkResponse({ type: ClassChatReportListResponseDto })
  async reports(
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<{ items: ClassChatReport[] }> {
    return { items: await this.classChat.reports(getAuthenticatedSession(request).userId) };
  }

  @Post("reports/:id/resolve")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "(담임) 신고 처리 완료" })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF_HEADER)
  @ApiNoContentResponse()
  @HttpCode(204)
  async resolveReport(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.classChat.resolveReport(getAuthenticatedSession(request).userId, idOrNotFound(id));
  }

  @Put("room")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "(담임) 대화방 열기·닫기" })
  @ApiBody({ type: UpdateClassChatRoomDto })
  @ApiHeader(CSRF_HEADER)
  @ApiOkResponse({ type: ClassChatStateResponseDto })
  setRoom(
    @Body() body: UpdateClassChatRoomDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ClassChatState> {
    const session = getAuthenticatedSession(request);
    return this.withAuthorPhotos(session, this.classChat.setRoom(session.userId, body.is_open));
  }

  @Put("mutes/:memberId")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "(담임) 학생 말하기 잠시 멈추기" })
  @ApiParam(MEMBER_PARAM)
  @ApiBody({ type: MuteClassChatMemberDto })
  @ApiHeader(CSRF_HEADER)
  @ApiNoContentResponse()
  @HttpCode(204)
  async mute(
    @Param("memberId") memberId: string,
    @Body() body: MuteClassChatMemberDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.classChat.mute(
      getAuthenticatedSession(request).userId,
      idOrNotFound(memberId),
      body.duration,
    );
  }

  @Delete("mutes/:memberId")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "(담임) 말하기 멈춤 풀기" })
  @ApiParam(MEMBER_PARAM)
  @ApiHeader(CSRF_HEADER)
  @ApiNoContentResponse()
  @HttpCode(204)
  async unmute(
    @Param("memberId") memberId: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.classChat.unmute(getAuthenticatedSession(request).userId, idOrNotFound(memberId));
  }

  /** 대화 상태를 돌려주는 모든 경로에서 작성자마다 '사진 있음'을 붙인다(화면이 이 응답으로 상태를 바꾼다). */
  private async withAuthorPhotos(
    actor: ProfilePhotoActor,
    pending: Promise<ClassChatState>,
  ): Promise<ClassChatState> {
    const result = await pending;
    const withPhoto = await this.photos.memberIdsWithPhoto(
      actor,
      result.messages.map((message) => message.author.member_id),
    );
    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        author: { ...message.author, has_profile_photo: withPhoto.has(message.author.member_id) },
      })),
    };
  }
}
