import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { ListAuditLogsQueryDto } from "./audit-logs.dto.js";
import { AuditLogListResponseDto } from "./audit-logs.openapi.js";
import { AuditLogsService } from "./audit-logs.service.js";
import { AUDIT_LOG_DAY_OPTIONS, type AuditLogListResult } from "./audit-logs.types.js";

@ApiTags("audit-logs")
@Controller("audit-logs")
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사의 현재 반 감사 로그 조회" })
  @ApiQuery({ name: "action", required: false, type: String })
  @ApiQuery({ name: "cursor", required: false, type: String })
  // DTO 검증과 같은 목록을 쓴다. 따로 적어두면 선택지를 늘릴 때 계약만 뒤처진다.
  @ApiQuery({ enum: [...AUDIT_LOG_DAY_OPTIONS], name: "days", required: false, type: Number })
  @ApiOkResponse({
    description: "최신순 20개 current class 감사 로그",
    type: AuditLogListResponseDto,
  })
  list(
    @Query() query: ListAuditLogsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<AuditLogListResult> {
    const session = getAuthenticatedSession(request);
    return this.auditLogsService.list({
      action: query.action ?? null,
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      days: query.days ?? 90,
    });
  }
}
