import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";

import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { AdminAccountsController } from "./admin-accounts.controller.js";
import { AdminAccountsService } from "./admin-accounts.service.js";

@Module({
  imports: [AdminAuthModule, AuthModule],
  controllers: [AdminAccountsController],
  providers: [AdminAccountsService],
})
export class AdminAccountsModule {}
