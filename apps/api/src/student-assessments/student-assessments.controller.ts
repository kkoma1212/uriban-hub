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
  ApiProduces,
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
  ExportStudentAssessmentsQueryDto,
  ListStudentAssessmentsQueryDto,
  StudentAssessmentWriteDto,
  StudentAssessmentCreateDto,
} from "./student-assessments.dto.js";
import {
  StudentAssessmentItemResponseDto,
  StudentAssessmentListResponseDto,
  StudentAssessmentCreationContextResponseDto,
} from "./student-assessments.openapi.js";
import { StudentAssessmentsService } from "./student-assessments.service.js";
import type {
  StudentAssessmentItem,
  StudentAssessmentWriteFields,
} from "./student-assessments.types.js";

const ETAG_RESPONSE_HEADERS = {
  ETag: {
    description: "현재 row_version의 quoted strong ETag",
    schema: { example: '"1"', type: "string" },
  },
} as const;

function writeFields(body: StudentAssessmentWriteDto): StudentAssessmentWriteFields {
  return {
    ...(body.academic_year === undefined ? {} : { academicYear: body.academic_year }),
    ...(body.assessment_date === undefined ? {} : { assessmentDate: body.assessment_date }),
    ...(body.assessment_type === undefined ? {} : { assessmentType: body.assessment_type }),
    ...(body.max_score_hundredths === undefined
      ? {}
      : { maxScoreHundredths: body.max_score_hundredths }),
    ...(body.memo === undefined ? {} : { memo: body.memo }),
    ...(body.score_hundredths === undefined ? {} : { scoreHundredths: body.score_hundredths }),
    ...(body.semester === undefined ? {} : { semester: body.semester }),
    ...(body.subject === undefined ? {} : { subject: body.subject }),
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.weight_basis_points === undefined
      ? {}
      : { weightBasisPoints: body.weight_basis_points }),
  };
}

@ApiTags("my-assessments")
@Controller("my-assessments")
export class StudentAssessmentsController {
  constructor(private readonly assessments: StudentAssessmentsService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "학생 본인의 초안·완료 평가 기록 목록" })
  @ApiOkResponse({ type: StudentAssessmentListResponseDto })
  list(
    @Query() query: ListStudentAssessmentsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
  ) {
    const session = getAuthenticatedSession(request);
    return this.assessments.list({
      actorUserId: session.userId,
      ...(query.academic_year === undefined ? {} : { academicYear: query.academic_year }),
      ...(query.semester === undefined ? {} : { semester: query.semester }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  }

  @Get("export.csv")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "학생 본인의 완료 평가 기록 CSV 내보내기" })
  @ApiProduces("text/csv")
  @ApiOkResponse({ description: "UTF-8 BOM CSV", schema: { type: "string" } })
  async exportCsv(
    @Query() query: ExportStudentAssessmentsQueryDto,
    @Req() request: AuthenticatedFastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    const csv = await this.assessments.exportCsv({
      actorUserId: session.userId,
      ...(query.academic_year === undefined ? {} : { academicYear: query.academic_year }),
      ...(query.semester === undefined ? {} : { semester: query.semester }),
    });
    void reply
      .header(
        "Content-Disposition",
        "attachment; filename=\"my-assessments.csv\"; filename*=UTF-8''%EB%82%98%EC%9D%98-%ED%8F%89%EA%B0%80.csv",
      )
      .type("text/csv; charset=utf-8")
      .send(csv);
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 평가 초안 멱등 생성" })
  @ApiBody({ type: StudentAssessmentCreateDto })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { format: "uuid", type: "string" },
  })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiCreatedResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: StudentAssessmentItemResponseDto,
  })
  async create(
    @Body() body: StudentAssessmentCreateDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StudentAssessmentItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.assessments.create({
      actorUserId: session.userId,
      idempotencyKey,
      ...(body.connection_scope === undefined ? {} : { connectionScope: body.connection_scope }),
      currentClassId: session.currentClassId,
      ...(body.expected_class_id === undefined ? {} : { expectedClassId: body.expected_class_id }),
      ...writeFields(body),
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Get("creation-context")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOkResponse({ type: StudentAssessmentCreationContextResponseDto })
  creationContext(@Req() request: AuthenticatedFastifyRequest) {
    const session = getAuthenticatedSession(request);
    return this.assessments.creationContext(session.userId, session.currentClassId);
  }

  @Get(":id")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "학생 본인의 평가 기록 상세" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiOkResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: StudentAssessmentItemResponseDto,
  })
  async get(
    @Param("id") id: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StudentAssessmentItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.assessments.get(session.userId, id);
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Patch(":id")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 평가 기록 자동 저장" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiBody({ type: StudentAssessmentWriteDto })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: StudentAssessmentItemResponseDto,
  })
  async update(
    @Param("id") id: string,
    @Body() body: StudentAssessmentWriteDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StudentAssessmentItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.assessments.update({
      actorUserId: session.userId,
      assessmentId: id,
      ifMatch,
      ...writeFields(body),
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Post(":id/complete")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 평가 초안 완료" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({
    headers: ETAG_RESPONSE_HEADERS,
    type: StudentAssessmentItemResponseDto,
  })
  async complete(
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StudentAssessmentItem> {
    const session = getAuthenticatedSession(request);
    const result = await this.assessments.complete(session.userId, id, ifMatch);
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "학생 본인의 평가 기록 즉시 hard delete" })
  @ApiParam({ name: "id", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiNoContentResponse({ description: "평가 기록 즉시 삭제 완료" })
  async delete(
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    await this.assessments.delete(session.userId, id, ifMatch);
  }
}
