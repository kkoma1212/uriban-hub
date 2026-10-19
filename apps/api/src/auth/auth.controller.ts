import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  createSecurityAuditHttpContext,
  SecurityAuditHttpProducer,
} from "../security-audit/security-audit-http.producer.js";
import { AllowUnverifiedEmail } from "./allow-unverified-email.decorator.js";
import { AuthService } from "./auth.service.js";
import {
  ConfirmEmailRequestDto,
  ConfirmGuardianConsentRequestDto,
  GuardianConsentRequestDto,
  GuardianConsentStatusRequestDto,
  LoginRequestDto,
  SignUpRequestDto,
  SignUpResponseDto,
  SignUpOptionsResponseDto,
} from "./auth.dto.js";
import type {
  ConfirmEmailResult,
  GuardianConsentConfirmResult,
  GuardianConsentRequestResult,
  GuardianConsentStatusResult,
  LoginResult,
  ResendEmailResult,
} from "./auth.types.js";
import { AuthenticatedCsrfGuard } from "./authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "./authenticated-request.js";
import { PreAuthOriginGuard } from "./pre-auth-origin.guard.js";
import {
  ConfirmPasswordResetRequestDto,
  ConfirmPasswordResetResponseDto,
  PasswordResetRequestDto,
  PasswordResetRequestResponseDto,
} from "./password-reset.dto.js";
import { PasswordResetEnabledGuard } from "./password-reset-enabled.guard.js";
import { PasswordResetService } from "./password-reset.service.js";
import type {
  ConfirmPasswordResetResult,
  PasswordResetRequestResult,
} from "./password-reset.types.js";
import {
  clearSessionCookies,
  createCsrfCookie,
  createSessionCookies,
  readCookie,
  SESSION_COOKIE_NAME,
} from "./session-cookie.js";
import { SessionService } from "./session.service.js";
import { EmailAlreadyRegisteredException } from "./auth.errors.js";
import { publicAccountResponse } from "./public-account-response.js";
import {
  AccountRequestAdmissionGuard,
  AccountRequestBudget,
} from "./account-request-admission.guard.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordResetService: PasswordResetService,
    private readonly sessionService: SessionService,
    private readonly securityAuditProducer: SecurityAuditHttpProducer,
  ) {}

  @Post("guardian-consent-requests")
  @HttpCode(202)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "만 14세 미만 가입을 위한 보호자 동의 요청" })
  @ApiResponse({ status: 202, description: "보호자 동의 요청 접수" })
  requestGuardianConsent(
    @Body() body: GuardianConsentRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<GuardianConsentRequestResult> {
    return body.legal_documents === undefined
      ? this.authService.requestGuardianConsent(body.guardian_email, request.ip)
      : this.authService.requestGuardianConsent(
          body.guardian_email,
          request.ip,
          body.legal_documents,
        );
  }

  @Post("guardian-consents/confirm")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "보호자 동의 확정" })
  @ApiResponse({ status: 200, description: "보호자 동의 완료" })
  confirmGuardianConsent(
    @Body() body: ConfirmGuardianConsentRequestDto,
  ): Promise<GuardianConsentConfirmResult> {
    return body.legal_documents === undefined
      ? this.authService.confirmGuardianConsent(body.token)
      : this.authService.confirmGuardianConsent(body.token, body.legal_documents);
  }

  @Post("guardian-consent-requests/status")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "보호자 동의 요청 상태 확인" })
  @ApiResponse({ status: 200, description: "보호자 동의 요청 상태" })
  getGuardianConsentStatus(
    @Body() body: GuardianConsentStatusRequestDto,
  ): Promise<GuardianConsentStatusResult> {
    return this.authService.getGuardianConsentStatus(body);
  }

  @Get("sign-up-options")
  @ApiOperation({ summary: "가입 화면 설정(생년월일을 받는 환경인지)" })
  @ApiResponse({
    status: 200,
    description: "가입 화면이 보여 줄 입력 항목",
    type: SignUpOptionsResponseDto,
  })
  signUpOptions(): SignUpOptionsResponseDto {
    return this.authService.signUpOptions();
  }

  @Post("sign-up")
  @HttpCode(202)
  @UseGuards(PreAuthOriginGuard, AccountRequestAdmissionGuard)
  @AccountRequestBudget("account-request")
  @ApiOperation({ summary: "교사·학생 계정 가입" })
  @ApiResponse({
    status: 202,
    description: "계정 존재와 메일 전달 결과를 노출하지 않는 가입 요청 접수",
    type: SignUpResponseDto,
  })
  signUp(
    @Body() body: SignUpRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<SignUpResponseDto> {
    return publicAccountResponse(async () => {
      try {
        await this.authService.signUp(body, request.ip, {
          requestId: request.id,
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
        });
      } catch (error) {
        // Only a confirmed duplicate maps to acceptance. Validation, admission,
        // storage and infrastructure failures must retain their real outcomes.
        if (!(error instanceof EmailAlreadyRegisteredException)) throw error;
      }
      return { next_action: "LOGIN", request_accepted: true };
    });
  }

  @Post("signup-approval/resend")
  @HttpCode(200)
  @AllowUnverifiedEmail()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "본인 가입 인증번호 이메일 재발송" })
  resendSignupApproval(@Req() request: AuthenticatedFastifyRequest) {
    return this.authService.resendSignupApproval(
      getAuthenticatedSession(request).userId,
      request.id,
      request.ip,
    );
  }

  @Post("email-verifications/confirm")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "이메일 인증 확정" })
  @ApiResponse({ status: 200, description: "이메일 인증 완료" })
  confirmEmail(@Body() body: ConfirmEmailRequestDto): Promise<ConfirmEmailResult> {
    return this.authService.confirmEmail(body.token);
  }

  @Post("password-reset-requests")
  @HttpCode(202)
  @UseGuards(PasswordResetEnabledGuard, PreAuthOriginGuard, AccountRequestAdmissionGuard)
  @AccountRequestBudget("account-request")
  @ApiOperation({ summary: "비밀번호 재설정 메일 요청" })
  @ApiBody({ type: PasswordResetRequestDto })
  @ApiResponse({
    status: 202,
    description: "계정 존재나 메일 발송 결과를 노출하지 않고 요청 접수",
    type: PasswordResetRequestResponseDto,
  })
  requestPasswordReset(
    @Body() body: PasswordResetRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<PasswordResetRequestResult> {
    return publicAccountResponse(() =>
      this.passwordResetService.requestReset(body.email, {
        clientIp: request.ip,
        requestId: request.id,
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : undefined,
      }),
    );
  }

  @Post("password-resets/confirm")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard, AccountRequestAdmissionGuard)
  @AccountRequestBudget("reset-confirm")
  @ApiOperation({ summary: "비밀번호 재설정 완료" })
  @ApiBody({ type: ConfirmPasswordResetRequestDto })
  @ApiResponse({
    status: 200,
    description: "비밀번호 변경, 로그인 잠금 해제와 모든 세션 폐기 완료",
    type: ConfirmPasswordResetResponseDto,
  })
  async confirmPasswordReset(
    @Body() body: ConfirmPasswordResetRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ConfirmPasswordResetResult> {
    const result = await this.passwordResetService.confirmReset(body.token, body.new_password, {
      clientIp: request.ip,
      requestId: request.id,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
    });
    void reply.header("Set-Cookie", clearSessionCookies());
    return result;
  }

  @Post("email-verifications/resend")
  @HttpCode(200)
  @AllowUnverifiedEmail()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "현재 미인증 계정의 이메일 인증 메일 재발송" })
  @ApiResponse({ status: 200, description: "기존 인증 token 폐기와 새 인증 메일 발송" })
  resendEmail(@Req() request: AuthenticatedFastifyRequest): Promise<ResendEmailResult> {
    const session = getAuthenticatedSession(request);
    return this.authService.resendVerification(session.userId, request.ip, {
      requestId: request.id,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
    });
  }

  @Post("login")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "이메일과 비밀번호로 로그인" })
  async login(
    @Body() body: LoginRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResult> {
    const session = await this.sessionService.login(
      body,
      request.ip,
      request.headers["user-agent"],
    );
    void reply.header(
      "Set-Cookie",
      createSessionCookies(session.sessionToken, session.csrfToken, session.expiresAt),
    );

    return { next_action: session.next_action };
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "현재 세션 로그아웃" })
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ logged_out: true }> {
    const auditIdentity = await this.sessionService.logout(
      readCookie(request.headers.cookie, SESSION_COOKIE_NAME),
    );
    void reply.header("Set-Cookie", clearSessionCookies());
    if (auditIdentity !== null) {
      try {
        void this.securityAuditProducer
          .recordLogout(createSecurityAuditHttpContext(request), auditIdentity)
          .catch(() => undefined);
      } catch {
        // Audit enrichment is deliberately isolated from the logout response contract.
      }
    }
    return { logged_out: true };
  }

  @Post("csrf-token")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @ApiOperation({ summary: "현재 세션의 CSRF token 재발급" })
  async refreshCsrf(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ csrf_refreshed: true }> {
    const refreshed = await this.sessionService.refreshCsrf(
      readCookie(request.headers.cookie, SESSION_COOKIE_NAME),
    );
    void reply.header("Set-Cookie", createCsrfCookie(refreshed.csrfToken, refreshed.expiresAt));
    return { csrf_refreshed: true };
  }
}
