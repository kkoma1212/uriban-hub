import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminCsrfGuard } from "./admin-csrf.guard.js";
import { AdminRolesGuard } from "./admin-roles.guard.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminStepUpGuard } from "./admin-step-up.guard.js";
import { AdminPasskeysService } from "./admin-passkeys.service.js";
import { AdminPasskeysController } from "./admin-passkeys.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [AdminAuthController, AdminPasskeysController],
  providers: [
    AdminAuthService,
    AdminPasskeysService,
    AdminCsrfGuard,
    AdminRolesGuard,
    AdminSessionGuard,
    AdminStepUpGuard,
  ],
  exports: [AdminAuthService, AdminCsrfGuard, AdminRolesGuard, AdminSessionGuard, AdminStepUpGuard],
})
export class AdminAuthModule {}
