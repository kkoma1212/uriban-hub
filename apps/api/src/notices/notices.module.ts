import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ContentAudiencesModule } from "../content-audiences/content-audiences.module.js";
import { InAppRemindersModule } from "../in-app-reminders/in-app-reminders.module.js";
import { NoticesAccessService } from "./notices-access.service.js";
import { NoticesCommandService } from "./notices-command.service.js";
import { NoticesController } from "./notices.controller.js";
import { NoticesQueryService } from "./notices-query.service.js";
import { NoticesService } from "./notices.service.js";

@Module({
  imports: [AuthModule, ContentAudiencesModule, InAppRemindersModule],
  controllers: [NoticesController],
  providers: [NoticesAccessService, NoticesCommandService, NoticesQueryService, NoticesService],
  exports: [NoticesAccessService, NoticesService],
})
export class NoticesModule {}
