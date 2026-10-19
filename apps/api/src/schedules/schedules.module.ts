import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { NeisSchoolSchedulesService } from "./neis-school-schedules.service.js";
import { ScheduleLinksService } from "./schedule-links.service.js";
import { SchedulesAccessService } from "./schedules-access.service.js";
import { SchedulesCommandService } from "./schedules-command.service.js";
import { SchedulesController } from "./schedules.controller.js";
import { SchedulesQueryService } from "./schedules-query.service.js";
import { SchedulesService } from "./schedules.service.js";

@Module({
  imports: [AuthModule],
  controllers: [SchedulesController],
  providers: [
    NeisSchoolSchedulesService,
    ScheduleLinksService,
    SchedulesAccessService,
    SchedulesCommandService,
    SchedulesQueryService,
    SchedulesService,
  ],
  exports: [SchedulesService],
})
export class SchedulesModule {}
