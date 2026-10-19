import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { PollsController } from "./polls.controller.js";
import { PollsService } from "./polls.service.js";

@Module({
  imports: [AuthModule],
  controllers: [PollsController],
  providers: [PollsService],
  exports: [PollsService],
})
export class PollsModule {}
