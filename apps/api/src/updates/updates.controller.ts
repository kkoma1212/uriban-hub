import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { ListUpdatesQueryDto } from "./updates.dto.js";
import { UpdatesListResponseDto } from "./updates.openapi.js";
import { UpdatesService } from "./updates.service.js";
import type { ListUpdatesResult } from "./updates.types.js";

@ApiTags("updates")
@Controller("updates")
export class UpdatesController {
  constructor(private readonly updatesService: UpdatesService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "공지·준비물을 발행 시각순으로 통합 조회" })
  @ApiQuery({
    enum: [
      "all",
      "notices",
      "materials",
      "important",
      "performance",
      "supplies",
      "homework",
      "unresolved",
    ],
    name: "filter",
    required: false,
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ description: "20개 커서 페이지 통합 알림 목록", type: UpdatesListResponseDto })
  list(
    @Query() query: ListUpdatesQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListUpdatesResult> {
    const session = getAuthenticatedSession(request);
    return this.updatesService.list({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      filter: query.filter ?? "all",
      ...(query.q === undefined ? {} : { search: query.q }),
    });
  }
}
