import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { LayoutDraftsAccessService } from "./layout-drafts.access.service.js";
import { LayoutDraftsController } from "./layout-drafts.controller.js";
import { LayoutDraftsService } from "./layout-drafts.service.js";

@Module({
  imports: [AuthModule],
  controllers: [LayoutDraftsController],
  providers: [LayoutDraftsAccessService, LayoutDraftsService],
  /* 교실 배치 템플릿이 같은 역할 판정을 빌려 쓴다 — 사본을 만들지 않기 위해. */
  exports: [LayoutDraftsAccessService],
})
export class LayoutDraftsModule {}
