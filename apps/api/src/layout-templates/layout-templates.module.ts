import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { LayoutDraftsModule } from "../layout-drafts/layout-drafts.module.js";
import { LayoutTemplatesController } from "./layout-templates.controller.js";
import { LayoutTemplatesService } from "./layout-templates.service.js";

/*
 * 역할 판정 서비스를 임시저장 모듈에서 빌려 쓴다. 조건이 한 글자도 다르지 않은데
 * 사본을 만들면 T-HUB-20(접근 제어 서비스가 열 벌) 부채가 하나 더 늘고, 나중에 한쪽만
 * 고쳐져 구멍이 된다.
 */
@Module({
  imports: [AuthModule, LayoutDraftsModule],
  controllers: [LayoutTemplatesController],
  providers: [LayoutTemplatesService],
})
export class LayoutTemplatesModule {}
