import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ContentAudiencesModule } from "../content-audiences/content-audiences.module.js";
import { NoticesModule } from "../notices/notices.module.js";
import { PastClassesController } from "./past-classes.controller.js";
import { PastClassesService } from "./past-classes.service.js";
import { UpdatesController } from "./updates.controller.js";
import { UpdatesService } from "./updates.service.js";

/*
 * `POLLS_ENABLED` 스위치는 더 이상 여기로 들어오지 않는다(2026-08-18). 통합 알림이
 * 투표를 싣지 않으므로 켜고 끌 것이 없다 — 스위치 자체는 투표 화면 쪽에서 계속 쓴다.
 */
@Module({
  imports: [AuthModule, ContentAudiencesModule, NoticesModule],
  controllers: [UpdatesController, PastClassesController],
  providers: [UpdatesService, PastClassesService],
  // 홈의 '아직 안 본 것' 숫자가 소식 탭과 같은 기준을 쓰도록(2026-10-03 총검수 B2-01).
  exports: [UpdatesService],
})
export class UpdatesModule {}
