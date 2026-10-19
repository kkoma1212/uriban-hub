import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { StudentAssessmentsAccessService } from "./student-assessments-access.service.js";
import { StudentAssessmentsController } from "./student-assessments.controller.js";
import { StudentAssessmentsService } from "./student-assessments.service.js";

@Module({
  imports: [AuthModule],
  controllers: [StudentAssessmentsController],
  providers: [StudentAssessmentsAccessService, StudentAssessmentsService],
})
export class StudentAssessmentsModule {}
