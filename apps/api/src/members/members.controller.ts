import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { parseRequiredIfMatch } from "../common/http/if-match.js";
import {
  ApproveMemberDto,
  GetMemberProfileResponseDto,
  ListMembersResponseDto,
  ListMembersQueryDto,
  MemberReasonDto,
  UpdateMemberProfileDto,
  UpdateMemberProfileResponseDto,
} from "./members.dto.js";
import { MemberPhotoPresenceReader } from "../profile-photos/member-photo-presence.js";
import { MemberBirthDateReader } from "./member-birth-dates.js";
import { MembersService } from "./members.service.js";
import type {
  ApproveMemberResult,
  GetMemberProfileResult,
  ListMembersResult,
  MemberTransitionResult,
  UpdateMemberProfileResult,
} from "./members.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

@ApiTags("members")
@Controller("members")
export class MembersController {
  constructor(
    private readonly membersService: MembersService,
    private readonly birthDates: MemberBirthDateReader,
    private readonly photos: MemberPhotoPresenceReader,
  ) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사용 구성원 관리 목록" })
  @ApiResponse({
    status: 200,
    description: "상태별 구성원 목록",
    type: ListMembersResponseDto,
  })
  async list(
    @Query() query: ListMembersQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListMembersResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.membersService.list(session.userId, query.status);
    const members = await this.birthDates.attach(result.members);
    const withPhoto = await this.photos.memberIdsWithPhoto(
      session,
      members.map((member) => member.id),
    );
    return {
      members: members.map((member) => ({
        ...member,
        has_profile_photo: withPhoto.has(member.id),
      })),
    };
  }

  @Get(":id/profile")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사의 승인 학생 비민감 정보 조회" })
  @ApiResponse({
    status: 200,
    description: "승인 학생의 반 표시명·학생 번호·계정 상태",
    headers: ETAG_RESPONSE_HEADERS,
    type: GetMemberProfileResponseDto,
  })
  async getProfile(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GetMemberProfileResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.membersService.getProfile(session.userId, id);
    reply.header("ETag", `"${result.member.row_version}"`);
    return result;
  }

  @Post(":id/approve")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "대기 중인 학생 가입 요청 승인" })
  @ApiResponse({ status: 200, description: "승인된 학생 구성원" })
  approve(
    @Param("id") id: string,
    @Body() body: ApproveMemberDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ApproveMemberResult> {
    const session = getAuthenticatedSession(request);
    return this.membersService.approve({
      actorUserId: session.userId,
      displayNameInClass: body.display_name_in_class,
      memberId: id,
      requestId: request.id,
      studentNumber: body.student_number,
    });
  }

  @Post(":id/reject")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "대기 중인 학생 가입 요청 거절" })
  @ApiResponse({ status: 200, description: "거절된 학생 구성원" })
  reject(
    @Param("id") id: string,
    @Body() body: MemberReasonDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<MemberTransitionResult> {
    const session = getAuthenticatedSession(request);
    return this.membersService.reject({
      actorUserId: session.userId,
      memberId: id,
      reason: body.reason === "" ? null : body.reason,
      requestId: request.id,
    });
  }

  @Post(":id/remove")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "승인된 학생 퇴출" })
  @ApiResponse({ status: 200, description: "퇴출된 학생 구성원" })
  remove(
    @Param("id") id: string,
    @Body() body: MemberReasonDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<MemberTransitionResult> {
    const session = getAuthenticatedSession(request);
    return this.membersService.remove({
      actorUserId: session.userId,
      memberId: id,
      reason: body.reason === "" ? null : body.reason,
      requestId: request.id,
    });
  }

  @Post(":id/allow-rejoin")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "퇴출된 학생의 재가입 허용" })
  @ApiResponse({ status: 200, description: "재가입이 허용된 학생 구성원" })
  allowRejoin(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<MemberTransitionResult> {
    const session = getAuthenticatedSession(request);
    return this.membersService.allowRejoin({
      actorUserId: session.userId,
      memberId: id,
      reason: null,
      requestId: request.id,
    });
  }

  @Patch(":id/profile")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 승인 학생 반 표시명·학생 번호 수정" })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiResponse({
    status: 200,
    description: "수정되었거나 no-op인 승인 학생 정보",
    headers: ETAG_RESPONSE_HEADERS,
    type: UpdateMemberProfileResponseDto,
  })
  async updateProfile(
    @Param("id") id: string,
    @Body() body: UpdateMemberProfileDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UpdateMemberProfileResult> {
    const expectedRowVersion = parseRequiredIfMatch(ifMatch);
    if (body.display_name_in_class === undefined && body.student_number === undefined) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "반 표시명 또는 학생 번호 중 하나 이상을 보내 주세요.",
      });
    }

    const session = getAuthenticatedSession(request);
    const result = await this.membersService.updateProfile({
      actorUserId: session.userId,
      ...(body.display_name_in_class === undefined
        ? {}
        : { displayNameInClass: body.display_name_in_class }),
      expectedRowVersion,
      memberId: id,
      requestId: request.id,
      ...(body.student_number === undefined ? {} : { studentNumber: body.student_number }),
    });
    reply.header("ETag", `"${result.member.row_version}"`);
    return result;
  }
}
