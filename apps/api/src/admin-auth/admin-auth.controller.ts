import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";

import { PreAuthOriginGuard } from "../auth/pre-auth-origin.guard.js";
import {
  ADMIN_CHALLENGE_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_CSRF_COOKIE_NAME,
  clearAdminChallengeCookie,
  clearAdminSessionCookies,
  createAdminChallengeCookie,
  createAdminSessionCookies,
  readAdminCookie,
} from "./admin-auth.cookies.js";
import {
  AdminChangePasswordRequestDto,
  AdminLoginRequestDto,
  AdminStepUpRequestDto,
  AdminTotpRequestDto,
} from "./admin-auth.dto.js";
import {
  adminRequestMetadata,
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "./admin-auth.request.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminCsrfGuard } from "./admin-csrf.guard.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminStepUpGuard } from "./admin-step-up.guard.js";

export function sessionResponse(session: ReturnType<typeof getAuthenticatedAdminSession>) {
  return {
    server_now: new Date().toISOString(),
    account: {
      display_name: session.displayName,
      email: session.email,
      id: session.adminAccountId,
      roles: session.roles,
    },
    session: {
      absolute_expires_at: session.absoluteExpiresAt.toISOString(),
      issued_at: session.issuedAt.toISOString(),
      last_seen_at: session.lastSeenAt.toISOString(),
      mfa_verified_at: session.mfaVerifiedAt.toISOString(),
      reauthenticated_at: session.reauthenticatedAt?.toISOString() ?? null,
    },
  };
}

@ApiTags("admin-auth")
@Controller("admin/auth")
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post("login")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "관리자 비밀번호 1차 인증" })
  @ApiResponse({ status: 200, description: "TOTP 등록 또는 확인 단계 시작" })
  async login(
    @Body() body: AdminLoginRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.adminAuthService.beginLogin(
      body.email,
      body.password,
      adminRequestMetadata(request),
    );
    void reply.header("Set-Cookie", [
      ...clearAdminSessionCookies(),
      createAdminChallengeCookie(result.challengeToken, result.challengeExpiresAt),
    ]);
    return {
      challenge_expires_at: result.challengeExpiresAt.toISOString(),
      next_step: result.nextStep,
      ...(result.methods === undefined ? {} : { methods: result.methods }),
      ...(result.setup === undefined
        ? {}
        : {
            setup: {
              manual_key: result.setup.manualKey,
              otpauth_uri: result.setup.otpAuthUri,
            },
          }),
    };
  }

  @Post("totp")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "관리자 TOTP 등록 완료 또는 2차 인증" })
  async completeTotp(
    @Body() body: AdminTotpRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.adminAuthService.completeTotp(
      readAdminCookie(request.headers.cookie, ADMIN_CHALLENGE_COOKIE_NAME),
      body.totp_code,
      adminRequestMetadata(request),
    );
    void reply.header("Set-Cookie", [
      clearAdminChallengeCookie(),
      ...createAdminSessionCookies(
        result.sessionToken,
        result.csrfToken,
        result.session.absoluteExpiresAt,
      ),
    ]);
    return sessionResponse(result.session);
  }

  @Get("session")
  @UseGuards(AdminSessionGuard)
  @ApiOperation({ summary: "현재 관리자 세션 확인" })
  session(@Req() request: AuthenticatedAdminRequest) {
    return sessionResponse(getAuthenticatedAdminSession(request));
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  @ApiOperation({ summary: "현재 관리자 세션 종료" })
  async logout(
    @Req() request: AuthenticatedAdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ logged_out: true }> {
    await this.adminAuthService.logout(
      getAuthenticatedAdminSession(request),
      adminRequestMetadata(request),
    );
    void reply.header("Set-Cookie", clearAdminSessionCookies());
    return { logged_out: true };
  }

  @Post("renew")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  @ApiOperation({ summary: "만료 전 관리자 세션을 추가 인증 없이 30분 연장" })
  async renew(
    @Req() request: AuthenticatedAdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.adminAuthService.renew(
      getAuthenticatedAdminSession(request),
      adminRequestMetadata(request),
    );
    // AdminCsrfGuard has authenticated both cookie values before this handler.
    void reply.header(
      "Set-Cookie",
      createAdminSessionCookies(
        readAdminCookie(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME)!,
        readAdminCookie(request.headers.cookie, ADMIN_CSRF_COOKIE_NAME)!,
        result.absoluteExpiresAt,
      ),
    );
    return sessionResponse(result);
  }

  @Post("step-up")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  @ApiOperation({ summary: "중요 관리자 작업을 위한 비밀번호·TOTP 재인증" })
  async stepUp(@Body() body: AdminStepUpRequestDto, @Req() request: AuthenticatedAdminRequest) {
    const result = await this.adminAuthService.stepUp(
      getAuthenticatedAdminSession(request),
      body.password,
      body.totp_code,
      adminRequestMetadata(request),
    );
    return {
      reauthenticated_at: result.reauthenticatedAt.toISOString(),
      valid_until: result.validUntil.toISOString(),
    };
  }

  @Post("change-password")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  @ApiOperation({ summary: "관리자 본인 비밀번호 변경" })
  changePassword(
    @Body() body: AdminChangePasswordRequestDto,
    @Req() request: AuthenticatedAdminRequest,
  ): Promise<{ password_changed: true }> {
    return this.adminAuthService.changePassword(
      getAuthenticatedAdminSession(request),
      body.new_password,
      adminRequestMetadata(request),
    );
  }
}
