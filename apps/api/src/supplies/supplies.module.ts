import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ContentAudiencesModule } from "../content-audiences/content-audiences.module.js";
import { InAppRemindersModule } from "../in-app-reminders/in-app-reminders.module.js";
import { SuppliesAccessService } from "./supplies-access.service.js";
import { SuppliesCommandService } from "./supplies-command.service.js";
import { SuppliesController } from "./supplies.controller.js";
import { SuppliesQueryService } from "./supplies-query.service.js";
import { SuppliesService } from "./supplies.service.js";

@Module({
  imports: [AuthModule, ContentAudiencesModule, InAppRemindersModule],
  controllers: [SuppliesController],
  providers: [SuppliesAccessService, SuppliesCommandService, SuppliesQueryService, SuppliesService],
  exports: [SuppliesService],
})
export class SuppliesModule {}
