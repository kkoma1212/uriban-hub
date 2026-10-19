import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { InAppRemindersService } from "./in-app-reminders.service.js";

@Module({
  imports: [AuthModule],
  providers: [InAppRemindersService],
  exports: [InAppRemindersService],
})
export class InAppRemindersModule {}
