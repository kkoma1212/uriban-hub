import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { BootstrapController } from "./bootstrap.controller.js";
import { BootstrapService } from "./bootstrap.service.js";

@Module({
  imports: [AuthModule],
  controllers: [BootstrapController],
  providers: [BootstrapService],
})
export class BootstrapModule {}
