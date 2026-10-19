import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

import { AllowUnverifiedEmail } from "../auth/allow-unverified-email.decorator.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { readCookie, SESSION_COOKIE_NAME } from "../auth/session-cookie.js";
import { bootstrapSessionContext } from "./bootstrap-session-context.js";
import { BootstrapResponseDto } from "./bootstrap.dto.js";
import { BootstrapService } from "./bootstrap.service.js";

@ApiTags("bootstrap")
@Controller("bootstrap")
export class BootstrapController {
  constructor(private readonly bootstrapService: BootstrapService) {}

  @Get()
  @AllowUnverifiedEmail()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "로그인 계정의 첫 화면과 current 상태 조회" })
  @ApiResponse({
    status: 200,
    description: "PRD 4.8 우선순위에 따른 목적 화면",
    type: BootstrapResponseDto,
  })
  async getBootstrap(@Req() request: AuthenticatedFastifyRequest): Promise<BootstrapResponseDto> {
    const session = getAuthenticatedSession(request);
    const sessionContext = bootstrapSessionContext(
      session,
      readCookie(request.headers.cookie, SESSION_COOKIE_NAME),
    );
    return {
      ...(await this.bootstrapService.getForUser(session.userId)),
      session_context: sessionContext,
    };
  }
}
