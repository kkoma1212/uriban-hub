import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { CreatePollDto, ListPollsQueryDto, UpdatePollDto, VoteInPollDto } from "./polls.dto.js";
import {
  PollItemResponseDto,
  PollListResponseDto,
  PollParticipationResponseDto,
} from "./polls.openapi.js";
import { PollsService } from "./polls.service.js";
import type { PollItem, PollListResult, PollParticipationResult } from "./polls.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

@ApiTags("polls")
@Controller("polls")
export class PollsController {
  constructor(private readonly pollsService: PollsService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반의 진행 중·마감 투표 목록" })
  @ApiQuery({ enum: ["open", "closed"], name: "scope", required: true })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({ type: PollListResponseDto })
  list(
    @Query() query: ListPollsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<PollListResult> {
    const session = getAuthenticatedSession(request);
    return this.pollsService.list({
      actorUserId: session.userId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      scope: query.scope,
    });
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 단일 선택 투표 생성" })
  @ApiBody({ type: CreatePollDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: PollItemResponseDto,
  })
  async create(
    @Body() body: CreatePollDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PollItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.pollsService.create({
      actorUserId: session.userId,
      ballotVisibility: body.ballot_visibility ?? "private",
      closesAt: body.closes_at,
      description: body.description ?? null,
      idempotencyKey,
      options: body.options,
      requestId: request.id,
      resultsPolicy: body.results_policy ?? "after_vote",
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Get(":pollId/participation")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({
    summary: "담임 교사용 참여 현황(기명 투표일 때만 학생별 선택 포함)",
  })
  @ApiParam({ name: "pollId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({ type: PollParticipationResponseDto })
  participation(
    @Param("pollId") pollId: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<PollParticipationResult> {
    const session = getAuthenticatedSession(request);
    return this.pollsService.participation({
      actorUserId: session.userId,
      pollId,
    });
  }

  @Post(":pollId/votes")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생의 변경 불가 단일 투표 제출" })
  @ApiParam({ name: "pollId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: VoteInPollDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: PollItemResponseDto,
  })
  async vote(
    @Param("pollId") pollId: string,
    @Body() body: VoteInPollDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PollItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.pollsService.vote({
      actorUserId: session.userId,
      idempotencyKey,
      optionId: body.option_id,
      pollId,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Get(":pollId")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 투표 상세" })
  @ApiParam({ name: "pollId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: PollItemResponseDto,
  })
  async get(
    @Param("pollId") pollId: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PollItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.pollsService.get({
      actorUserId: session.userId,
      pollId,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":pollId/close")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사가 응답을 보존하며 투표 즉시 종료" })
  @ApiParam({ name: "pollId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '\"1\"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ headers: ETAG_RESPONSE_HEADERS, type: PollItemResponseDto })
  async close(
    @Param("pollId") pollId: string,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PollItem> {
    const result = await this.pollsService.close({
      actorUserId: getAuthenticatedSession(request).userId,
      ifMatch,
      pollId,
      requestId: request.id,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Patch(":pollId")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사가 진행 중 투표의 제목·설명·마감·(0표일 때) 선택지 수정" })
  @ApiParam({ name: "pollId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: UpdatePollDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ headers: ETAG_RESPONSE_HEADERS, type: PollItemResponseDto })
  async update(
    @Param("pollId") pollId: string,
    @Body() body: UpdatePollDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PollItem> {
    const result = await this.pollsService.update({
      actorUserId: getAuthenticatedSession(request).userId,
      closesAt: body.closes_at,
      description: body.description ?? null,
      ifMatch,
      options: body.options,
      pollId,
      requestId: request.id,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Delete(":pollId")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 투표·선택지·응답 영구 삭제" })
  @ApiParam({ name: "pollId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiNoContentResponse({ description: "투표 영구 삭제 완료" })
  async delete(
    @Param("pollId") pollId: string,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    await this.pollsService.delete({
      actorUserId: session.userId,
      ifMatch,
      pollId,
      requestId: request.id,
    });
  }
}
