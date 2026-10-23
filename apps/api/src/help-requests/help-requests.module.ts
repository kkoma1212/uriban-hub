import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { MemberPhotoPresenceReader } from "../profile-photos/member-photo-presence.js";
import { HelpRequestsController } from "./help-requests.controller.js";
import { HelpRequestsService } from "./help-requests.service.js";

@Module({
  imports: [AuthModule],
  controllers: [HelpRequestsController],
  providers: [HelpRequestsService, MemberPhotoPresenceReader],
})
export class HelpRequestsModule {}
