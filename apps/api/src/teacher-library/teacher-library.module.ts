import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TeacherLibraryController } from "./teacher-library.controller.js";
import { TeacherLibraryService } from "./teacher-library.service.js";

/*
 * S2 교사 자료함. 운영 DB에 원장 84·85(teacher_library_items)를 적용하고 API 권한 프로필을
 * app_teacher_library_v1로 바꾼 뒤에만 app.module에 등록한다 — 표가 없는 DB에서는 쓸 수 없다.
 */
@Module({
  imports: [AuthModule],
  controllers: [TeacherLibraryController],
  providers: [TeacherLibraryService],
})
export class TeacherLibraryModule {}
