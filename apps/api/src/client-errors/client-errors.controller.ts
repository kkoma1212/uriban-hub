import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiNoContentResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { ReportClientErrorDto } from "./client-errors.dto.js";
import { ClientErrorStore } from "./client-errors.store.js";

const CSRF_HEADER = { name: "X-CSRF-Token", required: true, schema: { type: "string" } } as const;

@ApiTags("client-errors")
@Controller("client-errors")
export class ClientErrorsController {
  constructor(private readonly store: ClientErrorStore) {}

  /** 한도를 넘었거나 저장소가 멈춘 보고도 204로 끝낸다 — 진단 보고가 화면에 오류를 만들지 않게. */
  @Post()
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "화면 오류 한 건 보고(화면 모양·오류 종류만, 개인정보 없음)" })
  @ApiHeader(CSRF_HEADER)
  @ApiBody({ type: ReportClientErrorDto })
  @ApiNoContentResponse()
  async report(
    @Body() body: ReportClientErrorDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.store
      .record(getAuthenticatedSession(request).userId, {
        device: body.device,
        name: body.name,
        role: body.role,
        route: body.route,
        source: body.source,
      })
      .catch(() => false);
  }
}
