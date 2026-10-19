import { Body, Controller, Get, Header, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsObject, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PreAuthOriginGuard } from "../auth/pre-auth-origin.guard.js";
import {
  ADMIN_CHALLENGE_COOKIE_NAME,
  clearAdminChallengeCookie,
  createAdminSessionCookies,
  readAdminCookie,
} from "./admin-auth.cookies.js";
import { sessionResponse } from "./admin-auth.controller.js";
import {
  adminRequestMetadata,
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "./admin-auth.request.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminCsrfGuard } from "./admin-csrf.guard.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminPasskeysService } from "./admin-passkeys.service.js";
import type { AdminSessionIssueResult } from "./admin-auth.types.js";

class CeremonyDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  ceremony_id!: string;
}
export class AdminPasskeyAssertionDto extends CeremonyDto {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "WebAuthn AuthenticationResponseJSON; verified by SimpleWebAuthn.",
    writeOnly: true,
  })
  @IsObject()
  response!: AuthenticationResponseJSON;
}
export class AdminPasskeyStepUpDto extends AdminPasskeyAssertionDto {
  @ApiProperty({ type: String, minLength: 1, writeOnly: true })
  @IsString()
  @MinLength(1)
  password!: string;
}
export class AdminPasskeyRegistrationDto extends CeremonyDto {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "WebAuthn RegistrationResponseJSON; verified by SimpleWebAuthn.",
    writeOnly: true,
  })
  @IsObject()
  response!: RegistrationResponseJSON;
  @ApiProperty({ type: String, minLength: 1, maxLength: 60 })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u)
  label!: string;
}
export class AdminPasskeyRevokeDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 1400,
    pattern: "^[A-Za-z0-9_-]+$",
    writeOnly: true,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1400)
  @Matches(/^[A-Za-z0-9_-]+$/u)
  credential_id!: string;
}
export class AdminRecoveryDto {
  @ApiProperty({
    type: String,
    minLength: 32,
    maxLength: 39,
    pattern: "^[a-fA-F0-9-]+$",
    writeOnly: true,
  })
  @IsString()
  @MinLength(32)
  @MaxLength(39)
  @Matches(/^[a-fA-F0-9-]+$/u)
  recovery_code!: string;
}
export class AdminRecoveryStepUpDto extends AdminRecoveryDto {
  @ApiProperty({ type: String, minLength: 1, writeOnly: true })
  @IsString()
  @MinLength(1)
  password!: string;
}
function issueSession(result: AdminSessionIssueResult, reply: FastifyReply) {
  void reply.header("Cache-Control", "no-store");
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

@ApiTags("admin-auth")
@Controller("admin/auth")
export class AdminPasskeysController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly passkeys: AdminPasskeysService,
  ) {}
  @Get("factors")
  @UseGuards(AdminSessionGuard)
  @Header("Cache-Control", "no-store")
  factors(@Req() request: AuthenticatedAdminRequest) {
    return this.passkeys.factors(getAuthenticatedAdminSession(request));
  }

  @Post("passkeys/login/options")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  @Header("Cache-Control", "no-store")
  loginOptions(@Req() request: FastifyRequest) {
    return this.auth.beginPasskeyLogin(
      readAdminCookie(request.headers.cookie, ADMIN_CHALLENGE_COOKIE_NAME),
      adminRequestMetadata(request),
    );
  }
  @Post("passkeys/login/verify")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  async login(
    @Body() body: AdminPasskeyAssertionDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return issueSession(
      await this.auth.completeAlternativeLogin(
        readAdminCookie(request.headers.cookie, ADMIN_CHALLENGE_COOKIE_NAME),
        { kind: "passkey", ceremonyId: body.ceremony_id, response: body.response },
        adminRequestMetadata(request),
      ),
      reply,
    );
  }
  @Post("recovery/login")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  async recoveryLogin(
    @Body() body: AdminRecoveryDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return issueSession(
      await this.auth.completeAlternativeLogin(
        readAdminCookie(request.headers.cookie, ADMIN_CHALLENGE_COOKIE_NAME),
        { kind: "recovery", code: body.recovery_code },
        adminRequestMetadata(request),
      ),
      reply,
    );
  }
  @Post("passkeys/step-up/options")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  @Header("Cache-Control", "no-store")
  stepUpOptions(@Req() request: AuthenticatedAdminRequest) {
    return this.auth.beginPasskeyStepUp(
      getAuthenticatedAdminSession(request),
      adminRequestMetadata(request),
    );
  }
  @Post("passkeys/step-up/verify")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  async stepUp(@Body() body: AdminPasskeyStepUpDto, @Req() request: AuthenticatedAdminRequest) {
    const result = await this.auth.stepUpAlternative(
      getAuthenticatedAdminSession(request),
      body.password,
      { kind: "passkey", ceremonyId: body.ceremony_id, response: body.response },
      adminRequestMetadata(request),
    );
    return {
      reauthenticated_at: result.reauthenticatedAt.toISOString(),
      valid_until: result.validUntil.toISOString(),
    };
  }
  @Post("recovery/step-up")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  async recoveryStepUp(
    @Body() body: AdminRecoveryStepUpDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    const result = await this.auth.stepUpAlternative(
      getAuthenticatedAdminSession(request),
      body.password,
      { kind: "recovery", code: body.recovery_code },
      adminRequestMetadata(request),
    );
    return {
      reauthenticated_at: result.reauthenticatedAt.toISOString(),
      valid_until: result.validUntil.toISOString(),
    };
  }
  @Post("passkeys/registration/options")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  @Header("Cache-Control", "no-store")
  registrationOptions(@Req() request: AuthenticatedAdminRequest) {
    return this.passkeys.registrationOptions(
      getAuthenticatedAdminSession(request),
      adminRequestMetadata(request),
    );
  }
  @Post("passkeys/registration/verify")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  register(@Body() body: AdminPasskeyRegistrationDto, @Req() request: AuthenticatedAdminRequest) {
    return this.passkeys.register(
      getAuthenticatedAdminSession(request),
      body.ceremony_id,
      body.response,
      body.label.trim(),
      adminRequestMetadata(request),
    );
  }
  @Post("passkeys/revoke")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  revoke(@Body() body: AdminPasskeyRevokeDto, @Req() request: AuthenticatedAdminRequest) {
    return this.passkeys.revoke(
      getAuthenticatedAdminSession(request),
      body.credential_id,
      adminRequestMetadata(request),
    );
  }
  @Post("recovery-codes")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard)
  @Header("Cache-Control", "no-store")
  recoveryCodes(@Req() request: AuthenticatedAdminRequest) {
    return this.passkeys.regenerateRecoveryCodes(
      getAuthenticatedAdminSession(request),
      adminRequestMetadata(request),
    );
  }
}
