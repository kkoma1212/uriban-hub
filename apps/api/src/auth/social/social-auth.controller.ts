import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiProperty, OmitType } from "@nestjs/swagger";
import { EmailAlreadyRegisteredException } from "../auth.errors.js";
import { publicAccountResponse } from "../public-account-response.js";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SignUpRequestDto } from "../auth.dto.js";
import { AuthenticatedCsrfGuard } from "../authenticated-csrf.guard.js";
import { AuthenticatedSessionGuard } from "../authenticated-session.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../authenticated-request.js";
import { PreAuthOriginGuard } from "../pre-auth-origin.guard.js";
import { createSessionCookies, readCookie, SESSION_COOKIE_NAME } from "../session-cookie.js";
import { SocialAuthService } from "./social-auth.service.js";
import { isSocialProvider } from "./social-auth.environment.js";

export class SocialLinkRequestDto {
  @ApiProperty({
    required: false,
    type: String,
    writeOnly: true,
    description: "비밀번호가 있는 계정은 연결 전에 현재 비밀번호로 본인을 확인한다",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  current_password?: string;
}

export class SocialSignupRequestDto extends OmitType(SignUpRequestDto, ["password"] as const) {
  @ApiProperty({
    required: false,
    type: Boolean,
    description: "회사 프로필 사진을 우리반 허브 프로필 사진으로 쓸지(본인 선택, 기본 아니오)",
  })
  @IsOptional()
  @IsBoolean()
  use_provider_picture?: boolean;
}
export class SocialStartRequestDto {
  @ApiProperty({ enum: ["login", "signup_over_14"], type: String })
  @IsIn(["login", "signup_over_14"])
  intent!: "login" | "signup_over_14";
}
const OAUTH_COOKIE = "__Host-classhub_social";
const SIGNUP_COOKIE = "__Host-classhub_social_signup";
const cookie = (name: string, value: string) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${name === SIGNUP_COOKIE ? "Strict" : "Lax"}; Max-Age=${value ? 600 : 0}`;
function provider(value: string) {
  if (!isSocialProvider(value)) throw new NotFoundException();
  return value;
}

@Controller()
export class SocialAuthController {
  constructor(
    @Inject(SocialAuthService) private readonly service: SocialAuthService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  @Get("auth/social/providers")
  providers() {
    return { providers: this.service.provider.enabled() };
  }

  @Post("auth/social/:provider/start")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  async start(
    @Param("provider") name: string,
    @Body() body: SocialStartRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.service.start(provider(name), request.ip, undefined, body.intent);
    void reply.header("Set-Cookie", [
      cookie(OAUTH_COOKIE, result.browserSecret),
      cookie(SIGNUP_COOKIE, ""),
    ]);
    return { authorization_url: result.url };
  }
  @Get("auth/social/:provider/callback")
  async callback(
    @Param("provider") name: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const appOrigin = new URL(this.config.getOrThrow<string>("PUBLIC_APP_ORIGIN")).origin;
    try {
      const params = new URL(request.url, this.config.getOrThrow<string>("PUBLIC_API_ORIGIN"))
        .searchParams;
      const result = await this.service.callback(
        provider(name),
        params,
        readCookie(request.headers.cookie, OAUTH_COOKIE),
        readCookie(request.headers.cookie, SESSION_COOKIE_NAME),
        request.ip,
        request.headers["user-agent"],
      );
      const cleared = cookie(OAUTH_COOKIE, "");
      if (result.kind === "session") {
        void reply.header("Set-Cookie", [
          cleared,
          cookie(SIGNUP_COOKIE, ""),
          ...createSessionCookies(
            result.session.sessionToken,
            result.session.csrfToken,
            result.session.expiresAt,
          ),
        ]);
        return reply.redirect(`${appOrigin}/bootstrap`, 303);
      }
      if (result.kind === "signup") {
        void reply.header("Set-Cookie", [cleared, cookie(SIGNUP_COOKIE, result.browserSecret)]);
        return reply.redirect(`${appOrigin}/sign-up?social=1`, 303);
      }
      void reply.header("Set-Cookie", cleared);
      return reply.redirect(`${appOrigin}/account/social?social_linked=1`, 303);
    } catch (error) {
      // Never echo a provider's error/code/token into URLs or logs.
      void reply.header("Set-Cookie", [cookie(OAUTH_COOKIE, ""), cookie(SIGNUP_COOKIE, "")]);
      const code =
        error instanceof Error && "getResponse" in error && typeof error.getResponse === "function"
          ? (error.getResponse() as { code?: string }).code
          : undefined;
      // 연결(로그인한 상태)에서 막힌 경우는 연결 화면으로 돌려보내 이유를 보여 준다.
      if (code === "SOCIAL_LINKED_ELSEWHERE" || code === "SOCIAL_PROVIDER_ALREADY_LINKED")
        return reply.redirect(
          `${appOrigin}/account/social?social_error=${code === "SOCIAL_LINKED_ELSEWHERE" ? "linked_elsewhere" : "provider_taken"}&provider=${provider(name)}`,
          303,
        );
      // 연결 안 된 계정으로 로그인하면 그 회사로 '처음 가입'을 바로 고를 수 있게 회사 이름을 넘긴다.
      return reply.redirect(
        code === "SOCIAL_SIGNUP_REQUIRED"
          ? `${appOrigin}/login?social_error=signup_required&provider=${provider(name)}`
          : `${appOrigin}/login?social_error=invalid`,
        303,
      );
    }
  }
  @Get("auth/social/signup")
  pending(@Req() request: FastifyRequest) {
    return this.service.pendingSignup(readCookie(request.headers.cookie, SIGNUP_COOKIE));
  }

  @Post("auth/social/signup/cancel")
  @HttpCode(200)
  @UseGuards(PreAuthOriginGuard)
  async cancel(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.discardSignup(
      readCookie(request.headers.cookie, SIGNUP_COOKIE),
    );
    void reply.header("Set-Cookie", cookie(SIGNUP_COOKIE, ""));
    return result;
  }

  @Post("auth/social/signup")
  @HttpCode(201)
  @UseGuards(PreAuthOriginGuard)
  async signup(
    @Body() body: SocialSignupRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const secret = readCookie(request.headers.cookie, SIGNUP_COOKIE);
    // 총검수 I1-05: 일반 가입처럼 '이미 가입된 이메일'을 알려 주지 않고, 그 가입 흐름은 다시 못 쓰게 끝낸다.
    const outcome = await publicAccountResponse(async () => {
      try {
        return await this.service.signUp(secret, body, request.ip, {
          requestId: request.id,
          userAgent: request.headers["user-agent"],
        });
      } catch (error) {
        if (!(error instanceof EmailAlreadyRegisteredException)) throw error;
        await this.service.discardSignup(secret);
        return undefined;
      }
    });
    if (outcome === undefined) {
      void reply.header("Set-Cookie", cookie(SIGNUP_COOKIE, ""));
      return { next_action: "LOGIN", request_accepted: true };
    }
    const session = outcome;
    void reply.header("Set-Cookie", [
      cookie(SIGNUP_COOKIE, ""),
      ...createSessionCookies(session.sessionToken, session.csrfToken, session.expiresAt),
    ]);
    return { next_action: "BOOTSTRAP" };
  }
  @Get("account/social")
  @UseGuards(AuthenticatedSessionGuard)
  connections(@Req() request: AuthenticatedFastifyRequest) {
    return this.service.connections(getAuthenticatedSession(request));
  }

  @Post("account/social/:provider/link")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  async link(
    @Param("provider") name: string,
    @Body() body: SocialLinkRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const selected = provider(name);
    await this.service.confirmLinkIdentity(getAuthenticatedSession(request), body.current_password);
    const result = await this.service.start(selected, request.ip, {
      session: getAuthenticatedSession(request),
      rawSession: readCookie(request.headers.cookie, SESSION_COOKIE_NAME)!,
    });
    void reply.header("Set-Cookie", cookie(OAUTH_COOKIE, result.browserSecret));
    return { authorization_url: result.url };
  }
  @Post("account/social/:provider/unlink")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  unlink(@Param("provider") name: string, @Req() request: AuthenticatedFastifyRequest) {
    return this.service.unlink(getAuthenticatedSession(request), provider(name));
  }
}
