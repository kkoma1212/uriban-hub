import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { MemberPhotoPresenceReader } from "../profile-photos/member-photo-presence.js";
import { ClassChatController } from "./class-chat.controller.js";
import { ClassChatService } from "./class-chat.service.js";

/**
 * 반 단체 대화(선생님 관리형). CLASS_CHAT_ENABLED이고 DB에 원장 94·95(class_chat_* 표)가 적용된 뒤에만
 * app.module에 등록한다 — 표가 없는 DB에서는 쓸 수 없다.
 */
@Module({
  imports: [AuthModule],
  controllers: [ClassChatController],
  providers: [ClassChatService, MemberPhotoPresenceReader],
})
export class ClassChatModule {}
