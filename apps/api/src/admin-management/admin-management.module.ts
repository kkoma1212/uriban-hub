import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { ClientErrorsModule } from "../client-errors/client-errors.module.js";
import { AdminActivityService } from "./admin-activity.service.js";
import { AdminManagementController } from "./admin-management.controller.js";
import { AdminDirectoryService } from "./admin-directory.service.js";
import { AdminManagementService } from "./admin-management.service.js";
import { AdminOperationsService } from "./admin-operations.service.js";
import { AdminSessionsService } from "./admin-sessions.service.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { AdminReconfirmReportService } from "./admin-reconfirm-report.service.js";
import { AdminUsersService } from "./admin-users.service.js";
@Module({
  imports: [AdminAuthModule, AuthModule, ClientErrorsModule],
  controllers: [AdminManagementController],
  providers: [
    AdminActivityService,
    AdminDirectoryService,
    AdminManagementService,
    AdminOperationsService,
    AdminOverviewService,
    AdminReconfirmReportService,
    AdminSessionsService,
    AdminUsersService,
  ],
})
export class AdminManagementModule {}
