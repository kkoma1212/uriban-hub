import { Module } from "@nestjs/common";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { AdminSignupApprovalController } from "./admin-signup-approval.controller.js";
import { MailManagementController } from "../mail/mail-management.controller.js";
@Module({
  imports: [AdminAuthModule, AuthModule],
  controllers: [AdminSignupApprovalController, MailManagementController],
})
export class AdminSignupApprovalModule {}
