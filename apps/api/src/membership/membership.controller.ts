import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { CreateMembershipRequestDto } from "./membership.dto.js";
import { MembershipService } from "./membership.service.js";
import type {
  CreateMembershipRequestResult,
  OwnMembershipTransitionResult,
} from "./membership.types.js";

@ApiTags("membership")
@Controller("membership-requests")
export class MembershipController {
  constructor(private readonly membershipService: MembershipService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "초대 코드로 학생 반 가입 요청" })
  @ApiResponse({ status: 201, description: "pending 가입 요청 생성" })
  createRequest(
    @Body() body: CreateMembershipRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<CreateMembershipRequestResult> {
    const session = getAuthenticatedSession(request);
    return this.membershipService.createRequest({
      clientIp: request.ip,
      inviteCode: body.invite_code,
      requestId: request.id,
      userId: session.userId,
    });
  }

  @Post("current/cancel")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 pending 가입 요청 취소" })
  @ApiResponse({ status: 200, description: "pending 멤버십을 canceled로 전환" })
  cancelCurrentRequest(
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<OwnMembershipTransitionResult> {
    const session = getAuthenticatedSession(request);
    return this.membershipService.cancelCurrentRequest({
      requestId: request.id,
      userId: session.userId,
    });
  }
}

@ApiTags("membership")
@Controller("memberships/current")
export class CurrentMembershipController {
  constructor(private readonly membershipService: MembershipService) {}

  @Post("leave")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "approved 학생 본인의 현재 반 나가기" })
  @ApiResponse({ status: 200, description: "approved 멤버십을 left로 전환" })
  leaveCurrentMembership(
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<OwnMembershipTransitionResult> {
    const session = getAuthenticatedSession(request);
    return this.membershipService.leaveCurrentMembership({
      requestId: request.id,
      userId: session.userId,
    });
  }
}
