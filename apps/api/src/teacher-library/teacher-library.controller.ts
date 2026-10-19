import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import type { PersonalInfoHit } from "./personal-info.js";
import {
  CheckTeacherLibraryItemDto,
  CreateTeacherLibraryItemDto,
  ListTeacherLibraryQueryDto,
} from "./teacher-library.dto.js";
import { TeacherLibraryService, type TeacherLibraryItem } from "./teacher-library.service.js";

const CSRF_HEADER = { name: "X-CSRF-Token", required: true, schema: { type: "string" } } as const;

/** S2 교사 자료함. 고치기 경로는 없다 — 담기·보기·지우기만. */
@ApiTags("teacher-library")
@Controller("teacher-library")
export class TeacherLibraryController {
  constructor(private readonly library: TeacherLibraryService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "내 자료함 목록(최근 담은 순, 20개씩)" })
  list(
    @Query() query: ListTeacherLibraryQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<{ items: TeacherLibraryItem[]; next_cursor: string | null }> {
    return this.library.list(getAuthenticatedSession(request).userId, query);
  }

  @Get(":id")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "자료 하나(새 글 쓰기에 채울 내용)" })
  get(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<TeacherLibraryItem> {
    return this.library.get(getAuthenticatedSession(request).userId, id);
  }

  @Post("check")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiHeader(CSRF_HEADER)
  @ApiOperation({ summary: "담기 전 개인정보 모양(학생 이름·전화·이메일) 찾기" })
  check(
    @Body() body: CheckTeacherLibraryItemDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<{ hits: PersonalInfoHit[] }> {
    return this.library.check(getAuthenticatedSession(request).userId, body);
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiHeader(CSRF_HEADER)
  @ApiOperation({ summary: "개인정보 확인을 마친 글을 자료함에 담기" })
  create(
    @Body() body: CreateTeacherLibraryItemDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<TeacherLibraryItem> {
    return this.library.create(getAuthenticatedSession(request).userId, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiHeader(CSRF_HEADER)
  @ApiOperation({ summary: "자료 지우기(본인 것만)" })
  async remove(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.library.remove(getAuthenticatedSession(request).userId, id);
  }
}
