import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  AdminAccessLogInterceptor,
  RecordAdminAccess,
} from "../admin-access-log/admin-access-log.interceptor.js";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminRolesGuard, RequireAdminRoles } from "../admin-auth/admin-roles.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "../admin-auth/admin-auth.request.js";
import {
  IssueAdminSignupApprovalDto,
  FindAdminSignupAccountDto,
  RevokeAdminSignupApprovalDto,
} from "./admin-signup-approval.dto.js";
import { AdminSignupApprovalService } from "./admin-signup-approval.service.js";
@ApiTags("admin-signup-approvals")
@Controller("admin/signup-approvals")
@UseGuards(AdminSessionGuard, AdminRolesGuard)
@UseInterceptors(AdminAccessLogInterceptor)
@RequireAdminRoles("super_admin", "account_manager")
export class AdminSignupApprovalController {
  constructor(private readonly service: AdminSignupApprovalService) {}

  @Get()
  @RecordAdminAccess("signup_approvals.list", "signup_approval")
  list() {
    return this.service.list();
  }

  @Get("account")
  @RecordAdminAccess("signup_account.lookup", "user", (body) => {
    const account = (body as { account: { user_id: string } | null }).account;
    return account === null ? [] : [String(account.user_id)];
  })
  findAccount(@Query() query: FindAdminSignupAccountDto) {
    return this.service.findAccount(query.email, query.role);
  }

  @Post()
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  issue(@Body() body: IssueAdminSignupApprovalDto, @Req() request: AuthenticatedAdminRequest) {
    return this.service.issue(
      body.email,
      body.role,
      getAuthenticatedAdminSession(request).adminAccountId,
      request.id,
      false,
      request.ip,
    );
  }

  @Post("revoke")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  revoke(@Body() body: RevokeAdminSignupApprovalDto, @Req() request: AuthenticatedAdminRequest) {
    return this.service.revoke(
      body.id,
      getAuthenticatedAdminSession(request).adminAccountId,
      request.id,
    );
  }
}
