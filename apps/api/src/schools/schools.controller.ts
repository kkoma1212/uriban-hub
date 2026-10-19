import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { SearchSchoolsQueryDto } from "./schools.dto.js";
import { SchoolsService } from "./schools.service.js";
import type { SearchSchoolsResult } from "./schools.types.js";

@ApiTags("schools")
@Controller("schools")
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "반 생성용 학교 검색" })
  @ApiResponse({ status: 200, description: "학교명 부분 일치 결과 최대 20개" })
  async search(
    @Query() query: SearchSchoolsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<SearchSchoolsResult> {
    const session = getAuthenticatedSession(request);
    return this.schoolsService.search(session.userId, query.q);
  }
}
