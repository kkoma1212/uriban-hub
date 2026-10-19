import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import {
  AdminAccessLogInterceptor,
  RecordAdminAccess,
} from "../admin-access-log/admin-access-log.interceptor.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "../admin-auth/admin-auth.request.js";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminRolesGuard, RequireAdminRoles } from "../admin-auth/admin-roles.guard.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import {
  AdminAccountRecoveryDto,
  CreateAdminAccountDto,
  ReplaceAdminAccountRolesDto,
  UpdateAdminAccountStatusDto,
} from "./admin-accounts.dto.js";
import { AdminAccountsService } from "./admin-accounts.service.js";

@ApiTags("admin-accounts")
@Controller("admin/accounts")
@UseGuards(AdminSessionGuard, AdminRolesGuard)
@UseInterceptors(AdminAccessLogInterceptor)
@RequireAdminRoles("super_admin")
export class AdminAccountsController {
  constructor(private readonly service: AdminAccountsService) {}

  @Get()
  @RecordAdminAccess("admin_accounts.list", "admin_account")
  list() {
    return this.service.list();
  }

  @Post()
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  create(@Body() body: CreateAdminAccountDto, @Req() request: AuthenticatedAdminRequest) {
    const actor = getAuthenticatedAdminSession(request);
    return this.service.create(body, actor.adminAccountId, request.id);
  }

  @Patch(":id/status")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  updateStatus(
    @Param("id") id: string,
    @Body() body: UpdateAdminAccountStatusDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    const actor = getAuthenticatedAdminSession(request);
    return this.service.updateStatus(
      id,
      body.status,
      body.reason,
      actor.adminAccountId,
      request.id,
    );
  }

  @Put(":id/roles")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  replaceRoles(
    @Param("id") id: string,
    @Body() body: ReplaceAdminAccountRolesDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    const actor = getAuthenticatedAdminSession(request);
    return this.service.replaceRoles(id, body.roles, body.reason, actor.adminAccountId, request.id);
  }

  @Post(":id/reset-credentials")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  resetCredentials(
    @Param("id") id: string,
    @Body() body: AdminAccountRecoveryDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    const actor = getAuthenticatedAdminSession(request);
    return this.service.resetCredentials(id, body.reason, actor.adminAccountId, request.id);
  }

  @Post(":id/reset-mfa")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  resetMfa(
    @Param("id") id: string,
    @Body() body: AdminAccountRecoveryDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    const actor = getAuthenticatedAdminSession(request);
    return this.service.resetMfa(id, body.reason, actor.adminAccountId, request.id);
  }
}
