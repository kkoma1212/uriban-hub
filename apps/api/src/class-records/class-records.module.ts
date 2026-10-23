import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { NoticesModule } from "../notices/notices.module.js";
import { UpdatesModule } from "../updates/updates.module.js";
import { ClassRecordsController } from "./class-records.controller.js";
import { ClassRecordsService } from "./class-records.service.js";

@Module({
  imports: [AuthModule, NoticesModule, UpdatesModule],
  controllers: [ClassRecordsController],
  providers: [ClassRecordsService],
})
export class ClassRecordsModule {}
