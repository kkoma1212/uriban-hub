import { Module } from "@nestjs/common";

import { LocalTestAdminController } from "./local-test-admin.controller.js";
import { LocalTestAdminDatabase } from "./local-test-admin.database.js";
import { LocalTestAdminEnabledGuard } from "./local-test-admin-enabled.guard.js";
import { LocalTestAdminService } from "./local-test-admin.service.js";

@Module({
  controllers: [LocalTestAdminController],
  providers: [LocalTestAdminDatabase, LocalTestAdminEnabledGuard, LocalTestAdminService],
})
export class LocalTestAdminModule {}
