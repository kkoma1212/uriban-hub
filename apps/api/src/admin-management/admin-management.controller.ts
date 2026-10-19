import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  AdminAccessLogInterceptor,
  RecordAdminAccess,
} from "../admin-access-log/admin-access-log.interceptor.js";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminRolesGuard } from "../admin-auth/admin-roles.guard.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "../admin-auth/admin-auth.request.js";
import { RequireAdminRoles } from "../admin-auth/admin-roles.guard.js";
import { ClientErrorStore } from "../client-errors/client-errors.store.js";
import { AdminActivityService } from "./admin-activity.service.js";
import { adminError } from "./admin-error.js";
import {
  AdminActivityTrendQueryDto,
  ListAdminClassActivityQueryDto,
  ListAdminClassesQueryDto,
  ListAdminPeopleQueryDto,
  ListAdminSessionsQueryDto,
  RevokeAdminSessionDto,
} from "./admin-directory.dto.js";
import { AdminDirectoryService } from "./admin-directory.service.js";
import { AdminManagementService } from "./admin-management.service.js";
import { AdminOperationsService } from "./admin-operations.service.js";
import { AdminSessionsService } from "./admin-sessions.service.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { AdminUsersService } from "./admin-users.service.js";
import {
  AdminSystemStateKey,
  CreateAdminTermsVersionDto,
  ListAdminAuditQueryDto,
  ListAdminAuthAuditQueryDto,
  ListAdminOperationAuditQueryDto,
  ListAdminInquiriesQueryDto,
  ListAdminMembersQueryDto,
  ListAdminTermsConsentsQueryDto,
  ListAdminUsersQueryDto,
  ResetAdminUserPasswordDto,
  UpdateAdminInquiryDto,
  UpdateAdminMemberStatusDto,
  UpdateAdminSystemStateDto,
  UpdateAdminTermsVersionStatusDto,
  UpdateAdminUserStatusDto,
} from "./admin-management.dto.js";

@ApiTags("admin-management")
@Controller("admin")
@UseGuards(AdminSessionGuard, AdminRolesGuard)
@UseInterceptors(AdminAccessLogInterceptor)
export class AdminManagementController {
  constructor(
    private readonly service: AdminManagementService,
    private readonly users: AdminUsersService,
    private readonly overviewService: AdminOverviewService,
    private readonly directory: AdminDirectoryService,
    private readonly activity: AdminActivityService,
    private readonly operations: AdminOperationsService,
    private readonly sessions: AdminSessionsService,
    private readonly clientErrors: ClientErrorStore,
  ) {}
  /** 첫 화면 한눈에 보기: 숫자만 돌려주므로 모든 관리자 역할이 본다. */
  @Get("overview")
  @RequireAdminRoles("super_admin", "account_manager", "support", "security_auditor")
  overview() {
    return this.overviewService.overview();
  }
  /** 첫 화면 일별 추이: 하루마다 새 가입·새 활동 건수만(숫자만이라 모든 관리자 역할이 본다). */
  @Get("activity-trend")
  @RequireAdminRoles("super_admin", "account_manager", "support", "security_auditor")
  activityTrend(@Query() query: AdminActivityTrendQueryDto) {
    return this.activity.activityTrend(query);
  }
  /** 학교·반 목록: 반 정보·담임 이름·인원 수만(학생 개인 정보·활동 내용 없음). */
  @Get("classes")
  @RecordAdminAccess("classes.list", "class")
  @RequireAdminRoles("super_admin", "account_manager", "support")
  listClasses(@Query() query: ListAdminClassesQueryDto) {
    return this.directory.listClasses(query);
  }
  /** 선생님·학생 목록: 검색 없이 전체를 쪽으로 본다. 메일은 가려서, 로그인 비밀·접속 주소는 없이. */
  @Get("people")
  @RecordAdminAccess("people.list", "user")
  @RequireAdminRoles("super_admin", "account_manager", "support")
  listPeople(@Query() query: ListAdminPeopleQueryDto) {
    return this.directory.listPeople(query);
  }
  /** 반 활동 현황: 운영 중인 반의 최근 7·30일 건수만(글 내용·작성자 없음). */
  @Get("class-activity")
  @RequireAdminRoles("super_admin", "account_manager", "support")
  listClassActivity(@Query() query: ListAdminClassActivityQueryDto) {
    return this.activity.listClassActivity(query);
  }
  @Get("users")
  @RecordAdminAccess("users.list", "user")
  @RequireAdminRoles("super_admin", "account_manager", "support")
  listUsers(@Query() query: ListAdminUsersQueryDto, @Req() request: AuthenticatedAdminRequest) {
    // 메일 전체는 계정 관리 권한이 있는 관리자에게만(상담 담당은 가린 메일, 총검수 C2-09·I2-04).
    const roles = getAuthenticatedAdminSession(request).roles;
    return this.users.list(query.search, {
      revealEmail: roles.includes("super_admin") || roles.includes("account_manager"),
    });
  }
  @Patch("users/:id/status")
  @RequireAdminRoles("super_admin", "account_manager")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  updateUserStatus(
    @Param("id") id: string,
    @Body() body: UpdateAdminUserStatusDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    return this.users.updateStatus(
      id,
      body.status,
      body.reason,
      getAuthenticatedAdminSession(request).adminAccountId,
      request.id,
    );
  }
  @Post("users/:id/reset-password")
  @RequireAdminRoles("super_admin", "account_manager")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  resetUserPassword(
    @Param("id") id: string,
    @Body() body: ResetAdminUserPasswordDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    return this.users.issuePasswordReset(
      id,
      body.reason,
      getAuthenticatedAdminSession(request).adminAccountId,
      request.id,
      request.ip,
    );
  }
  @Get("members")
  @RecordAdminAccess("members.list", "member")
  @RequireAdminRoles("super_admin", "account_manager")
  listMembers(@Query() q: ListAdminMembersQueryDto) {
    return this.service.listMembers(q);
  }
  @Patch("members/:id/status")
  @RequireAdminRoles("super_admin", "account_manager")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  update(
    @Param("id") id: string,
    @Body() b: UpdateAdminMemberStatusDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    const s = getAuthenticatedAdminSession(req);
    return this.service.updateMember(id, b.status, b.reason, s.adminAccountId, req.id);
  }
  @Get("audit-logs")
  @RecordAdminAccess("class_audit.list", "audit_log")
  @RequireAdminRoles("super_admin", "security_auditor")
  listAudit(@Query() q: ListAdminAuditQueryDto) {
    return this.service.listAudits(q);
  }
  @Get("operation-audit-logs")
  @RecordAdminAccess("operation_audit.list", "audit_log")
  @RequireAdminRoles("super_admin", "security_auditor")
  listOperationAudits(@Query() query: ListAdminOperationAuditQueryDto) {
    return this.service.listOperationAudits(query);
  }
  @Get("auth-audit-logs")
  @RecordAdminAccess("auth_audit.list", "audit_log")
  @RequireAdminRoles("super_admin", "security_auditor")
  listAdminAuthAudits(@Query() query: ListAdminAuthAuditQueryDto) {
    return this.service.listAdminAuthAudits(query);
  }
  @Post("terms/versions")
  @RequireAdminRoles("super_admin")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  createTerms(@Body() b: CreateAdminTermsVersionDto, @Req() req: AuthenticatedAdminRequest) {
    return this.service.createTermsVersion(
      b,
      getAuthenticatedAdminSession(req).adminAccountId,
      req.id,
    );
  }
  @Patch("terms/versions/:id/status")
  @RequireAdminRoles("super_admin")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  updateTermsVersionStatus(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: UpdateAdminTermsVersionStatusDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    return this.service.updateTermsVersionStatus(
      id,
      body.status,
      body.effective_at,
      body.reason,
      getAuthenticatedAdminSession(request).adminAccountId,
      request.id,
    );
  }
  @Get("terms/versions")
  @RequireAdminRoles("super_admin", "security_auditor")
  listTerms() {
    return this.service.listTermsVersions();
  }
  @Get("terms/consents")
  @RecordAdminAccess("terms_consents.list", "user")
  @RequireAdminRoles("super_admin", "security_auditor")
  listConsents(@Query() q: ListAdminTermsConsentsQueryDto) {
    return this.service.listTermsConsents(q);
  }
  @Get("inquiries")
  @RecordAdminAccess("inquiries.list", "inquiry")
  @RequireAdminRoles("super_admin", "support")
  listInquiries(@Query() q: ListAdminInquiriesQueryDto) {
    return this.service.listInquiries(q.status);
  }
  @Patch("inquiries/:id")
  @RequireAdminRoles("super_admin", "support")
  @UseGuards(AdminCsrfGuard)
  updateInquiry(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() b: UpdateAdminInquiryDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.service.updateInquiry(
      id,
      b,
      getAuthenticatedAdminSession(req).adminAccountId,
      req.id,
    );
  }
  /** 운영 상태: 감사 격리 수·백업·복원 검증(=DB 설치 상태)을 숫자·시각·통과 여부로만. */
  @Get("operations-status")
  @RequireAdminRoles("super_admin", "security_auditor")
  operationsStatus() {
    return this.operations.status();
  }
  /** 최근 24시간 화면 오류: 화면 모양·오류 종류·건수만(Redis 한 시간 묶음, 25시간 뒤 지워짐). */
  @Get("client-errors")
  @RequireAdminRoles("super_admin", "security_auditor")
  async clientErrorSummary() {
    try {
      return await this.clientErrors.summary();
    } catch {
      throw adminError(ServiceUnavailableException, "ADMIN_CLIENT_ERRORS_UNAVAILABLE");
    }
  }
  /** 로그인 세션 목록(읽기 전용): 이름·가린 메일·기기 요약·시각만. 접속 주소·토큰 없음. */
  @Get("sessions")
  @RecordAdminAccess("sessions.list", "session")
  @RequireAdminRoles("super_admin", "security_auditor")
  listSessions(
    @Query() query: ListAdminSessionsQueryDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    return this.sessions.list(query, getAuthenticatedAdminSession(request).sessionId);
  }
  /** 로그인 세션 강제 종료: 최고 관리자만, 재인증·CSRF 뒤에. 끝낸 사실은 관리자 작업 기록에 남는다. */
  @Post("sessions/:id/revoke")
  @RequireAdminRoles("super_admin")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  revokeSession(
    @Param("id") id: string,
    @Body() body: RevokeAdminSessionDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    const session = getAuthenticatedAdminSession(request);
    return this.sessions.revoke({
      id,
      kind: body.kind,
      reason: body.reason,
      actorAdminId: session.adminAccountId,
      currentSessionId: session.sessionId,
      requestId: request.id,
    });
  }
  @Get("system-state") @RequireAdminRoles("super_admin", "security_auditor") systemState() {
    return this.service.getSystemState();
  }
  @Patch("system-state/:key")
  @RequireAdminRoles("super_admin")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  updateState(
    @Param("key", new ParseEnumPipe(AdminSystemStateKey)) key: AdminSystemStateKey,
    @Body() b: UpdateAdminSystemStateDto,
    @Req() req: AuthenticatedAdminRequest,
  ) {
    return this.service.updateSystemState(
      key,
      b.value,
      getAuthenticatedAdminSession(req).adminAccountId,
      req.id,
    );
  }
}
