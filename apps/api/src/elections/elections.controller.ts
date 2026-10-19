import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import {
  CastElectionVoteDto,
  CreateElectionDto,
  PublishElectionDto,
  RegisterElectionCandidateDto,
} from "./elections.dto.js";
import {
  ElectionCurrentResponseDto,
  ElectionItemResponseDto,
  ElectionListResponseDto,
  ElectionResultsResponseDto,
} from "./elections.openapi.js";
import { ElectionsService } from "./elections.service.js";
import type {
  ElectionCurrentResult,
  ElectionItem,
  ElectionListResult,
  ElectionResults,
} from "./elections.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

const ELECTION_ID_PARAM = {
  name: "electionId",
  schema: { pattern: "^[1-9][0-9]*$", type: "string" },
} as const;

@ApiTags("elections")
@Controller("elections")
export class ElectionsController {
  constructor(private readonly electionsService: ElectionsService) {}

  /** 학생도 부를 수 있는 유일한 선거 경로다. 진행 중인 선거만 보인다. */
  @Get("current")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "지금 투표할 수 있는 선거" })
  @ApiOkResponse({ type: ElectionCurrentResponseDto })
  current(@Req() request: AuthenticatedFastifyRequest): Promise<ElectionCurrentResult> {
    const session = getAuthenticatedSession(request);
    return this.electionsService.current({ actorUserId: session.userId });
  }

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사용 선거 목록" })
  @ApiOkResponse({ type: ElectionListResponseDto })
  list(@Req() request: AuthenticatedFastifyRequest): Promise<ElectionListResult> {
    const session = getAuthenticatedSession(request);
    return this.electionsService.list({ actorUserId: session.userId });
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 선거 생성" })
  @ApiBody({ type: CreateElectionDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({ headers: ETAG_RESPONSE_HEADERS, type: ElectionItemResponseDto })
  async create(
    @Body() body: CreateElectionDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ElectionItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.electionsService.create({
      actorUserId: session.userId,
      idempotencyKey,
      requestId: request.id,
      resultsVisibility: body.results_visibility,
      tieBreak: body.tie_break,
      title: body.title,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Get(":electionId")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사용 선거 상세" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiOkResponse({ headers: ETAG_RESPONSE_HEADERS, type: ElectionItemResponseDto })
  async get(
    @Param("electionId") electionId: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ElectionItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.electionsService.get({
      actorUserId: session.userId,
      electionId,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":electionId/candidates")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 후보 등록" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiBody({ type: RegisterElectionCandidateDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({ headers: ETAG_RESPONSE_HEADERS, type: ElectionItemResponseDto })
  async registerCandidate(
    @Param("electionId") electionId: string,
    @Body() body: RegisterElectionCandidateDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ElectionItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.electionsService.registerCandidate({
      actorUserId: session.userId,
      electionId,
      ifMatch,
      memberId: body.member_id,
      requestId: request.id,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":electionId/open")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 투표 시작" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ headers: ETAG_RESPONSE_HEADERS, type: ElectionItemResponseDto })
  async open(
    @Param("electionId") electionId: string,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ElectionItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.electionsService.open({
      actorUserId: session.userId,
      electionId,
      ifMatch,
      requestId: request.id,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  /*
   * 멱등성 키를 받지 않는다. 그 저장소가 요청 본문의 해시를 사용자 식별자와 같은
   * 행에 남기는데, 후보가 몇 명뿐이라 해시를 맞춰 보면 선택이 복원되기 때문이다.
   * 중복 투표는 참여 표의 기본키가 막는다.
   */
  @Post(":electionId/vote")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 투표" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiBody({ type: CastElectionVoteDto })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ type: ElectionCurrentResponseDto })
  vote(
    @Param("electionId") electionId: string,
    @Body() body: CastElectionVoteDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ElectionCurrentResult> {
    const session = getAuthenticatedSession(request);
    return this.electionsService.vote({
      actorUserId: session.userId,
      candidateId: body.candidate_id,
      electionId,
    });
  }

  @Post(":electionId/close")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 투표 마감" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ headers: ETAG_RESPONSE_HEADERS, type: ElectionItemResponseDto })
  async close(
    @Param("electionId") electionId: string,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ElectionItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.electionsService.close({
      actorUserId: session.userId,
      electionId,
      ifMatch,
      requestId: request.id,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  /** 학생은 발표된 뒤에만 부를 수 있다. */
  @Get(":electionId/results")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "개표 결과" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiOkResponse({ type: ElectionResultsResponseDto })
  results(
    @Param("electionId") electionId: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ElectionResults> {
    const session = getAuthenticatedSession(request);
    return this.electionsService.results({ actorUserId: session.userId, electionId });
  }

  @Post(":electionId/publish")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사 결과 발표" })
  @ApiParam(ELECTION_ID_PARAM)
  @ApiBody({ required: false, type: PublishElectionDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ type: ElectionResultsResponseDto })
  publish(
    @Param("electionId") electionId: string,
    @Body() body: PublishElectionDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ElectionResults> {
    const session = getAuthenticatedSession(request);
    return this.electionsService.publish({
      actorUserId: session.userId,
      electionId,
      ifMatch,
      requestId: request.id,
      winnerCandidateId: body.winner_candidate_id,
    });
  }
}
