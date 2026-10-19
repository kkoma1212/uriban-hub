import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { AttendanceNotificationsAccessService } from "./attendance-notifications-access.service.js";
import { AttendanceNotificationsCommandController } from "./attendance-notifications-command.controller.js";
import { AttendanceNotificationsCommandService } from "./attendance-notifications-command.service.js";
import { AttendanceNotificationsIdempotencyService } from "./attendance-notifications-idempotency.service.js";
import { AttendanceNotificationsController } from "./attendance-notifications.controller.js";
import { AttendanceNotificationsService } from "./attendance-notifications.service.js";

@Module({
  imports: [AuthModule],
  controllers: [AttendanceNotificationsCommandController, AttendanceNotificationsController],
  providers: [
    AttendanceNotificationsAccessService,
    AttendanceNotificationsCommandService,
    AttendanceNotificationsIdempotencyService,
    AttendanceNotificationsService,
  ],
  exports: [AttendanceNotificationsService],
})
export class AttendanceNotificationsModule {}
