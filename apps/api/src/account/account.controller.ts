import { Body, Controller, HttpCode, Patch, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AllowUnverifiedEmail } from "../auth/allow-unverified-email.decorator.js";
import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { clearSessionCookies } from "../auth/session-cookie.js";
import {
  ChangePasswordRequestDto,
  ChangePasswordResponseDto,
  DeleteAccountRequestDto,
  DeleteAccountResponseDto,
  UpdateAccountProfileRequestDto,
  UpdateAccountProfileResponseDto,
} from "./account.dto.js";
import { AccountService } from "./account.service.js";
import type {
  ChangePasswordResult,
  DeleteAccountResult,
  UpdateAccountProfileResult,
} from "./account.types.js";

@ApiTags("account")
@Controller("account")
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Patch("profile")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "내 계정 표시명 변경" })
  @ApiBody({ type: UpdateAccountProfileRequestDto })
  @ApiResponse({
    status: 200,
    description: "계정 표시명 변경 결과. 같은 값이면 기존 updated_at을 유지",
    type: UpdateAccountProfileResponseDto,
  })
  @ApiResponse({ status: 400, description: "표시명 형식 오류" })
  @ApiResponse({ status: 401, description: "현재 세션 또는 계정이 유효하지 않음" })
  @ApiResponse({ status: 403, description: "이메일, Origin 또는 CSRF 검증 실패" })
  async updateProfile(
    @Body() body: UpdateAccountProfileRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<UpdateAccountProfileResult> {
    const session = getAuthenticatedSession(request);
    return this.accountService.updateProfile({
      displayName: body.display_name,
      sessionId: session.sessionId,
      userId: session.userId,
    });
  }

  @Patch("password")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "로그인 상태에서 비밀번호 변경" })
  @ApiBody({ type: ChangePasswordRequestDto })
  @ApiResponse({
    status: 200,
    description: "비밀번호 변경과 모든 세션 폐기 완료",
    type: ChangePasswordResponseDto,
  })
  async changePassword(
    @Body() body: ChangePasswordRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ChangePasswordResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.accountService.changePassword({
      clientIp: request.ip,
      currentPassword: body.current_password,
      newPassword: body.new_password,
      sessionId: session.sessionId,
      userId: session.userId,
    });
    void reply.header("Set-Cookie", clearSessionCookies());
    return result;
  }

  @Post("deletion")
  @HttpCode(200)
  @AllowUnverifiedEmail()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "현재 비밀번호 재확인 후 계정 즉시 삭제·익명화" })
  @ApiBody({ type: DeleteAccountRequestDto })
  @ApiResponse({
    status: 200,
    description: "계정 익명화, 현재 학생 멤버십 종료와 세션·미사용 token 폐기 완료",
    type: DeleteAccountResponseDto,
  })
  @ApiResponse({ status: 400, description: "확인 문구 또는 요청 형식 오류" })
  @ApiResponse({ status: 401, description: "현재 세션 또는 현재 비밀번호가 유효하지 않음" })
  @ApiResponse({ status: 403, description: "Origin 또는 CSRF 검증 실패" })
  @ApiResponse({
    status: 409,
    description: "active/suspended 반 담당 교사는 아카이브 또는 이관 전 삭제 불가",
  })
  @ApiResponse({ status: 429, description: "현재 비밀번호 실패 횟수 제한 초과" })
  @ApiResponse({ status: 503, description: "rate limit 저장소 장애로 변경 전 실패" })
  async deleteAccount(
    @Body() body: DeleteAccountRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DeleteAccountResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.accountService.deleteAccount({
      clientIp: request.ip,
      confirmation: body.confirmation,
      currentPassword: body.current_password,
      requestId: request.id,
      sessionId: session.sessionId,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
      userId: session.userId,
    });
    void reply.header("Set-Cookie", clearSessionCookies());
    return result;
  }
}
