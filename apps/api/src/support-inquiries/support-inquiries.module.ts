import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { SupportInquiriesController } from "./support-inquiries.controller.js";
import { SupportInquiriesService } from "./support-inquiries.service.js";

@Module({
  imports: [AuthModule],
  controllers: [SupportInquiriesController],
  providers: [SupportInquiriesService],
})
export class SupportInquiriesModule {}
