import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ElectionsAccessService } from "./elections.access.service.js";
import { ElectionsController } from "./elections.controller.js";
import { ElectionsService } from "./elections.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ElectionsController],
  providers: [ElectionsAccessService, ElectionsService],
})
export class ElectionsModule {}
