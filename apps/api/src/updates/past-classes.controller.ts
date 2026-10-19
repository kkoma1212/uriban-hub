import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { PastClassesService, type PastClassSummary } from "./past-classes.service.js";
import { ListUpdatesQueryDto } from "./updates.dto.js";
import { UpdatesListResponseDto } from "./updates.openapi.js";
import type { ListUpdatesResult } from "./updates.types.js";

/** 지난 반은 읽기 전용이다 — 이 컨트롤러에는 GET만 둔다. */
@ApiTags("past-classes")
@Controller("past-classes")
export class PastClassesController {
  constructor(private readonly pastClasses: PastClassesService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "내가 속했던 지난 반(종료 후 365일 이내) 목록" })
  async list(@Req() request: AuthenticatedFastifyRequest): Promise<{ items: PastClassSummary[] }> {
    const session = getAuthenticatedSession(request);
    return { items: await this.pastClasses.listMine(session.userId) };
  }

  @Get(":classId/updates")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "지난 반의 공지·준비물 읽기 전용 통합 조회" })
  @ApiOkResponse({ description: "20개 커서 페이지", type: UpdatesListResponseDto })
  updates(
    @Param("classId") classId: string,
    @Query() query: ListUpdatesQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ListUpdatesResult> {
    const session = getAuthenticatedSession(request);
    return this.pastClasses.listUpdates(session.userId, classId, {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      filter: query.filter ?? "all",
      ...(query.q === undefined ? {} : { search: query.q }),
    });
  }
}
