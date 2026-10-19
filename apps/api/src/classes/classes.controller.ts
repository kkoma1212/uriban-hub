import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { parseRequiredIfMatch } from "../common/http/if-match.js";
import {
  ArchiveCurrentClassDto,
  ArchiveCurrentClassResponseDto,
  CreateClassDto,
  CurrentClassResponseDto,
  UpdateCurrentClassDto,
} from "./classes.dto.js";
import { ClassesService } from "./classes.service.js";
import type {
  ArchiveCurrentClassResult,
  CreateClassResult,
  CurrentClassResult,
  CurrentInviteCodeResult,
  RotateInviteCodeResult,
  UpdateCurrentClassResult,
} from "./classes.types.js";

@ApiTags("classes")
@Controller("classes")
export class ClassesCollectionController {
  constructor(private readonly classesService: ClassesService) {}

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "교사 현재 반 생성과 최초 초대 코드 발급" })
  @ApiResponse({ status: 201, description: "생성된 반과 최초 초대 코드" })
  create(
    @Body() body: CreateClassDto,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<CreateClassResult> {
    const session = getAuthenticatedSession(request);
    return this.classesService.create({
      academicYear: body.academic_year,
      actorUserId: session.userId,
      eduOfficeCode: body.edu_office_code,
      expectedStudentCount: body.expected_student_count,
      grade: body.grade,
      idempotencyKey,
      name: body.name,
      requestId: request.id,
      schoolCode: body.school_code,
    });
  }
}

@ApiTags("classes")
@Controller("classes/current")
export class ClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Post("archive")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 현재 반 아카이브와 모든 현재 접근 종료" })
  @ApiBody({ type: ArchiveCurrentClassDto })
  @ApiResponse({
    status: 200,
    description: "반·멤버십 종료와 열린 초대 코드 폐기 완료",
    type: ArchiveCurrentClassResponseDto,
  })
  @ApiResponse({ status: 400, description: "요청 본문 형식 또는 입력값 검증 오류" })
  @ApiResponse({ status: 401, description: "현재 계정 상태 또는 세션이 유효하지 않음" })
  @ApiResponse({ status: 403, description: "담임 교사 권한, Origin 또는 CSRF 검증 실패" })
  @ApiResponse({ status: 404, description: "현재 참여 중인 반을 찾을 수 없음" })
  @ApiResponse({ status: 409, description: "반 이름 확인 불일치 또는 반 상태 경합" })
  @ApiResponse({ status: 423, description: "현재 반이 일시 중지됨" })
  archiveCurrent(
    @Body() body: ArchiveCurrentClassDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<ArchiveCurrentClassResult> {
    const session = getAuthenticatedSession(request);
    return this.classesService.archiveCurrent({
      actorUserId: session.userId,
      classNameConfirmation: body.class_name_confirmation,
      expectedClassId: body.expected_class_id,
      expectedRowVersion: body.expected_row_version,
      requestId: request.id,
    });
  }

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 정보 조회" })
  @ApiResponse({
    status: 200,
    description: "역할에 맞는 현재 반과 읽기 전용 학교 기본정보",
    type: CurrentClassResponseDto,
  })
  async getCurrent(
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CurrentClassResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.classesService.getCurrent(session.userId);
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Patch()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 현재 반 표시명과 예상 학생 수 수정" })
  @ApiHeader({ name: "If-Match", required: true, schema: { example: '"1"', type: "string" } })
  @ApiResponse({ status: 200, description: "수정된 현재 반 정보", type: CurrentClassResponseDto })
  async updateCurrent(
    @Body() body: UpdateCurrentClassDto,
    @Headers("if-match") ifMatch: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UpdateCurrentClassResult> {
    const session = getAuthenticatedSession(request);
    const result = await this.classesService.updateCurrent({
      actorUserId: session.userId,
      expectedRowVersion: parseRequiredIfMatch(ifMatch),
      expectedStudentCount: body.expected_student_count,
      name: body.name,
      requestId: request.id,
    });
    reply.header("ETag", `"${result.row_version}"`);
    return result;
  }

  @Get("invite-code")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "담임 교사의 현재 초대 코드 조회" })
  @ApiResponse({ status: 200, description: "현재 초대 코드와 만료 상태" })
  getInviteCode(@Req() request: AuthenticatedFastifyRequest): Promise<CurrentInviteCodeResult> {
    const session = getAuthenticatedSession(request);
    return this.classesService.getCurrentInviteCode(session.userId);
  }

  @Post("invite-code/rotate")
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "담임 교사의 현재 초대 코드 재발급" })
  @ApiResponse({ status: 200, description: "폐기된 기존 코드 대신 생성된 새 코드" })
  rotateInviteCode(
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<RotateInviteCodeResult> {
    const session = getAuthenticatedSession(request);
    return this.classesService.rotateInviteCode({
      actorUserId: session.userId,
      idempotencyKey,
      requestId: request.id,
    });
  }
}
