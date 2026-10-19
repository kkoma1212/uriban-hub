import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  Inject,
} from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminRolesGuard, RequireAdminRoles } from "../admin-auth/admin-roles.guard.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "../admin-auth/admin-auth.request.js";
import { AdminSignupApprovalService } from "../admin-signup-approval/admin-signup-approval.service.js";
import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import { MailManagementService } from "./mail-management.service.js";

export class MailSearchDto {
  @ApiProperty({ required: false, format: "email" })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email?: string;
}

export class SendSignupMailDto {
  @ApiProperty({ format: "email" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;
  @ApiProperty({ enum: ["student", "teacher"] })
  @IsIn(["student", "teacher"])
  role!: "student" | "teacher";
}

export class UpdateSignupMailTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @CodePointLength(1, 120)
  @IsPlainText()
  title!: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @CodePointLength(1, 2000)
  @IsPlainText({ allowLineFeed: true })
  introduction!: string;
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString()
  @CodePointLength(1, 1000)
  @IsPlainText({ allowLineFeed: true })
  footer!: string;
  @ApiProperty({ minLength: 1, maxLength: 40 })
  @IsString()
  @CodePointLength(1, 40)
  @IsPlainText()
  button_label!: string;
}

@ApiTags("admin-mail")
@Controller("admin/mail")
@UseGuards(AdminSessionGuard, AdminRolesGuard)
@RequireAdminRoles("super_admin")
export class MailManagementController {
  constructor(
    private readonly management: MailManagementService,
    private readonly approvals: AdminSignupApprovalService,
    @Inject(AUTH_RATE_LIMITER) private readonly limiter: RedisRateLimiter,
  ) {}

  @Get()
  async list(@Query() query: MailSearchDto) {
    const [template, deliveries, approvals] = await Promise.all([
      this.management.template(),
      this.management.deliveries(query.email),
      this.approvals.listMailApprovals(),
    ]);
    return {
      template,
      deliveries,
      approvals: query.email
        ? approvals.filter((item) => item.recipient_email === query.email)
        : approvals,
    };
  }

  @Put("template")
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  updateTemplate(
    @Body() body: UpdateSignupMailTemplateDto,
    @Req() request: AuthenticatedAdminRequest,
  ) {
    return this.management.updateTemplate(
      body,
      getAuthenticatedAdminSession(request).adminAccountId,
      request.id,
    );
  }

  @Post("resend")
  @HttpCode(200)
  @UseGuards(AdminCsrfGuard, AdminStepUpGuard)
  async resend(@Body() body: SendSignupMailDto, @Req() request: AuthenticatedAdminRequest) {
    const adminId = getAuthenticatedAdminSession(request).adminAccountId;
    const limit = await this.limiter.consume({ key: `admin-signup-mail:account:${adminId}` });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    const result = await this.approvals.issue(
      body.email,
      body.role,
      adminId,
      request.id,
      true,
      request.ip,
    );
    return {
      email_delivery_status: result.email_delivery_status,
      expires_at: result.expiresAt.toISOString(),
    };
  }
}
